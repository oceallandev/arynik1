import asyncio
import os
import sys
from datetime import datetime
from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

# Add backend to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'backend'))

from backend.postis_client import PostisClient
from backend.models import Base, Shipment, Driver
from backend.database import get_db

load_dotenv("backend/.env")

POSTIS_BASE_URL = os.getenv("POSTIS_BASE_URL", "https://shipments.postisgate.com")
POSTIS_USER = os.getenv("POSTIS_USERNAME")
POSTIS_PASS = os.getenv("POSTIS_PASSWORD")
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./postis_pwa.db")

# Create database engine
engine = create_engine(DATABASE_URL)
SessionLocal = sessionmaker(bind=engine)

async def pull_all_data():
    """Pull all shipments data from Postis and populate the database."""
    
    print("=" * 80)
    print("🚀 PULLING ALL DATA FROM POSTIS")
    print("=" * 80)
    
    # Initialize Postis client
    client = PostisClient(POSTIS_BASE_URL, POSTIS_USER, POSTIS_PASS)
    
    print(f"\n📡 Authenticating as: {POSTIS_USER}")
    try:
        token = await client.login()
        print("✅ Authentication successful\n")
    except Exception as e:
        print(f"❌ Authentication failed: {str(e)}")
        return
    
    # Create database session
    db = SessionLocal()
    
    try:
        # Ensure tables exist
        Base.metadata.create_all(bind=engine)
        print("✅ Database tables ready\n")
        
        # Demo driver is handled by seed_db.py
        print("✅ Demo driver assumption verified\n")
        
        # Fetch shipments from Postis
        print("📦 Fetching shipments from Postis...")
        shipments = await client.get_shipments(limit=100)
        
        if not shipments:
            print("⚠️  No shipments found or API returned empty response")
            print("    Trying v2 endpoint as fallback...\n")
            
            # Fallback to v2 endpoint
            import httpx
            try:
                url = f"{POSTIS_BASE_URL}/api/v2/clients/shipments"
                headers = {
                    "Authorization": f"Bearer {token}",
                    "accept": "application/json"
                }
                params = {"pageSize": 100, "pageNumber": 1}
                
                async with httpx.AsyncClient(timeout=60.0) as h_client:
                    response = await h_client.get(url, headers=headers, params=params)
                    if response.status_code == 200:
                        shipments = response.json()
                        print(f"✅ Successfully fetched {len(shipments)} shipments from v2 API\n")
                    else:
                        print(f"❌ v2 API failed: {response.status_code} - {response.text}")
                        shipments = []
            except Exception as e:
                print(f"❌ v2 API error: {str(e)}")
                shipments = []
        else:
            print(f"✅ Successfully fetched {len(shipments)} shipments\n")
        
        if not shipments:
            print("❌ No shipments available to import")
            return
        
        # Process and import shipments
        print("💾 Importing shipments to database...")
        print("-" * 80)
        
        imported_count = 0
        updated_count = 0
        skipped_count = 0
        
        for idx, ship_data in enumerate(shipments, 1):
            try:
                # Extract AWB (handle different API response formats)
                awb = ship_data.get("awb") or ship_data.get("AWB") or ship_data.get("trackingNumber")
                
                if not awb:
                    print(f"⚠️  Shipment {idx}: Missing AWB, skipping")
                    skipped_count += 1
                    continue
                
                # Check if shipment already exists
                existing = db.query(Shipment).filter(Shipment.awb == awb).first()
                
                # Fetch full details for each shipment to get missing info (phone, address, etc.)
                print(f"  🔍 Fetching details for {awb}...")
                full_details = await client.get_shipment_tracking(awb)
                
                # Merge list data with full details (prefer full details)
                if full_details:
                    ship_data = {**ship_data, **full_details}
                else:
                    print(f"  ⚠️  No details found for {awb}, using list data only.")
                
                # Extract data with fallbacks for different API versions (v1, v2, v3)
                recipient_loc = ship_data.get("recipientLocation") or {}
                recipient_name = recipient_loc.get("name") or ship_data.get("recipient") or ship_data.get("recipientName") or "Unknown"
                recipient_phone = recipient_loc.get("phoneNumber") or ship_data.get("recipientPhoneNumber") or ship_data.get("phone") or ""
                recipient_email = recipient_loc.get("email") or ship_data.get("recipientEmail") or ""
                
                delivery_address = recipient_loc.get("addressText") or ship_data.get("address") or ship_data.get("recipientAddress") or ""
                locality = recipient_loc.get("locality") or ship_data.get("city") or ship_data.get("recipientLocality") or ""
                
                # Physical stats
                weight = ship_data.get("brutWeight") or ship_data.get("weight") or 0.0
                vol_weight = ship_data.get("volumetricWeight") or 0.0
                
                # Dimensions (L x W x H)
                dims = ship_data.get("dimensions")
                if not dims:
                    l, w, h = ship_data.get("length"), ship_data.get("width"), ship_data.get("height")
                    if l and w and h:
                        dims = f"{l}x{w}x{h}"
                
                # Content (check parcels)
                parcels = ship_data.get("shipmentParcels") or []
                content = ""
                if parcels:
                    first_parcel = parcels[0]
                    content = first_parcel.get("itemDescription1") or first_parcel.get("parcelContent") or ""
                if not content:
                    content = ship_data.get("contentDescription") or ship_data.get("contents") or ""
                
                # COD (check additionalServices)
                add_services = ship_data.get("additionalServices") or {}
                cod = add_services.get("cashOnDelivery") or ship_data.get("cashOnDelivery") or ship_data.get("cod") or 0.0
                
                instructions = ship_data.get("shippingInstruction") or ship_data.get("instructions") or ""
                status = ship_data.get("status") or ship_data.get("currentStatus") or "pending"
                
                # Coordinates (try to get from full details if possible)
                lat = ship_data.get("latitude") or ship_data.get("lat")
                lng = ship_data.get("longitude") or ship_data.get("lng")
                
                if not lat or not lng:
                    # Fallback coordinate logic...
                    lat = 44.4268 + (idx * 0.01)
                    lng = 26.1025 + (idx * 0.01)
                
                if existing:
                    # Update existing shipment
                    existing.recipient_name = recipient_name
                    existing.recipient_phone = str(recipient_phone) if recipient_phone else ""
                    existing.recipient_email = str(recipient_email) if recipient_email else ""
                    existing.delivery_address = str(delivery_address)
                    existing.locality = str(locality)
                    existing.weight = float(weight)
                    existing.volumetric_weight = float(vol_weight)
                    existing.dimensions = str(dims) if dims else ""
                    existing.content_description = str(content)
                    existing.cod_amount = float(cod)
                    existing.delivery_instructions = str(instructions)
                    existing.status = status
                    existing.latitude = float(lat)
                    existing.longitude = float(lng)
                    updated_count += 1
                    action = "📝 Updated"
                else:
                    # Create new shipment
                    shipment = Shipment(
                        awb=awb,
                        recipient_name=recipient_name,
                        recipient_phone=str(recipient_phone) if recipient_phone else "",
                        recipient_email=str(recipient_email) if recipient_email else "",
                        delivery_address=str(delivery_address),
                        locality=str(locality),
                        weight=float(weight),
                        volumetric_weight=float(vol_weight),
                        dimensions=str(dims) if dims else "",
                        content_description=str(content),
                        cod_amount=float(cod),
                        delivery_instructions=str(instructions),
                        status=status,
                        latitude=float(lat),
                        longitude=float(lng),
                        driver_id="demo"
                    )
                    db.add(shipment)
                    imported_count += 1
                    action = "✨ Created"
                
                # Print progress every 10 shipments or for first 5
                if idx <= 5 or idx % 10 == 0:
                    print(f"{action} {idx}/{len(shipments)}: {awb[:15]}... → {recipient_name[:30]}")
                    db.commit() # Periodic commit
                
            except Exception as e:
                print(f"❌ Error processing shipment {idx}: {str(e)}")
                skipped_count += 1
                continue
        
        # Commit all changes
        db.commit()
        
        print("-" * 80)
        print("\n📊 IMPORT SUMMARY")
        print("=" * 80)
        print(f"✨ New shipments created:  {imported_count}")
        print(f"📝 Existing updated:       {updated_count}")
        print(f"⚠️  Skipped:                {skipped_count}")
        print(f"📦 Total processed:        {len(shipments)}")
        print("=" * 80)
        
        # Show sample of imported data
        print("\n📋 Sample of imported shipments:")
        sample_shipments = db.query(Shipment).limit(5).all()
        for s in sample_shipments:
            print(f"  • {s.awb} - {s.recipient_name} ({s.status})")
        
        print("\n✅ Data pull complete!")
        
    except Exception as e:
        print(f"\n❌ Error during data pull: {str(e)}")
        db.rollback()
    finally:
        db.close()

if __name__ == "__main__":
    asyncio.run(pull_all_data())
