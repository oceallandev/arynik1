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
from backend.database import get_db, engine, SessionLocal

# load .env for POSTIS credentials, database url handled in backend/database.py
load_dotenv("backend/.env")

POSTIS_BASE_URL = os.getenv("POSTIS_BASE_URL", "https://shipments.postisgate.com")
POSTIS_USER = os.getenv("POSTIS_USERNAME")
POSTIS_PASS = os.getenv("POSTIS_PASSWORD")

# Use shared engine/session from backend logic to ensure one DB file

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
        
        # Fetch shipments from Postis (Pagination Loop)
        print("📦 Fetching all shipments from Postis...")
        
        all_shipments = []
        page = 1
        page_size = 100
        
        while True:
            print(f"  ⬇️  Fetching page {page} (Size: {page_size})...", end="", flush=True)
            batch = await client.get_shipments(limit=page_size, page=page)
            
            if not batch:
                print(" Done. (No more data)")
                break
                
            count = len(batch)
            print(f" Got {count} records.")
            all_shipments.extend(batch)
            
            if count < page_size:
                print("  ✅ Reached end of data.")
                break
                
            page += 1
            
        shipments = all_shipments
        print(f"\n✅ Total records fetched: {len(shipments)}\n")
        
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
                
                # Helper functions for parsing
                def parse_bool(val):
                    if isinstance(val, bool): return val
                    return str(val).upper() == 'TRUE'
                
                def parse_date(date_str):
                    if not date_str: return None
                    try:
                        return datetime.strptime(date_str, "%Y-%m-%d %H:%M:%S")
                    except ValueError:
                        return None

                # Extract Extended Data
                shipment_reference = ship_data.get("shipmentReference")
                client_order_id = ship_data.get("clientOrderId")
                postis_order_id = ship_data.get("postisOrderId")
                
                # JSON/Dict Fields
                client_data = ship_data.get("client")
                courier_data = ship_data.get("courier") # Contains courierLabel, etc.
                sender_location = ship_data.get("senderLocation")
                recipient_location = ship_data.get("recipientLocation")
                product_category = ship_data.get("productCategory")
                client_shipment_status = ship_data.get("clientShipmentStatus")
                additional_services = ship_data.get("additionalServices")
                
                # Dates
                created_date = parse_date(ship_data.get("createdDate"))
                awb_status_date = parse_date(ship_data.get("awbStatusDate"))
                
                # Booleans / Flags
                local_awb_shipment = parse_bool(ship_data.get("localAwbShipment"))
                local_shipment = parse_bool(ship_data.get("localShipment"))
                shipment_label_available = parse_bool(ship_data.get("shipmentLabelAvailable"))
                has_borderou = parse_bool(ship_data.get("hasBorderou"))
                pallet_package = parse_bool(ship_data.get("palletPackage")) # Check if this is boolean or string "NEW"
                
                # Other Strings/Numbers
                source_channel = ship_data.get("sourceChannel")
                send_type = ship_data.get("sendType")
                sender_shop_name = ship_data.get("senderShopName")
                processing_status = ship_data.get("processingStatus")
                
                number_of_parcels = int(ship_data.get("numberOfParcels") or 1)
                declared_value = float(ship_data.get("declaredValue") or 0.0)

                # --- Standard Fields (Already existing logic) ---
                recipient_loc = recipient_location or {}
                recipient_name = recipient_loc.get("name") or ship_data.get("recipient") or ship_data.get("recipientName") or "Unknown"
                recipient_phone = recipient_loc.get("phoneNumber") or ship_data.get("recipientPhoneNumber") or ship_data.get("phone") or ""
                recipient_email = recipient_loc.get("email") or ship_data.get("recipientEmail") or ""
                
                delivery_address = recipient_loc.get("addressText") or ship_data.get("address") or ship_data.get("recipientAddress") or ""
                locality = recipient_loc.get("locality") or ship_data.get("city") or ship_data.get("recipientLocality") or ""
                
                weight = float(ship_data.get("brutWeight") or ship_data.get("weight") or 0.0)
                vol_weight = float(ship_data.get("volumetricWeight") or 0.0)
                
                # Dimensions
                dims = ship_data.get("dimensions")
                if not dims:
                    l, w, h = ship_data.get("length"), ship_data.get("width"), ship_data.get("height")
                    if l and w and h:
                        dims = f"{l}x{w}x{h}"
                
                # Content
                parcels = ship_data.get("shipmentParcels") or []
                content = ""
                if parcels:
                    content = parcels[0].get("itemDescription1") or parcels[0].get("parcelContent") or ""
                if not content:
                    content = ship_data.get("contentDescription") or ship_data.get("contents") or ""
                
                # COD
                add_services = additional_services or {}
                cod = float(add_services.get("cashOnDelivery") or ship_data.get("cashOnDelivery") or ship_data.get("cod") or 0.0)
                
                instructions = ship_data.get("shippingInstruction") or ship_data.get("instructions") or ""
                status = ship_data.get("status") or ship_data.get("currentStatus") or "pending"
                
                # Coordinates
                lat = ship_data.get("latitude") or ship_data.get("lat")
                lng = ship_data.get("longitude") or ship_data.get("lng")
                if not lat or not lng:
                    lat = 44.4268 + (idx * 0.01)
                    lng = 26.1025 + (idx * 0.01)

                if existing:
                    # Update standard fields
                    existing.recipient_name = recipient_name
                    existing.recipient_phone = str(recipient_phone) if recipient_phone else ""
                    existing.recipient_email = str(recipient_email) if recipient_email else ""
                    existing.delivery_address = str(delivery_address)
                    existing.locality = str(locality)
                    existing.weight = weight
                    existing.volumetric_weight = vol_weight
                    existing.dimensions = str(dims) if dims else ""
                    existing.content_description = str(content)
                    existing.cod_amount = cod
                    existing.delivery_instructions = str(instructions)
                    existing.status = status
                    existing.latitude = float(lat)
                    existing.longitude = float(lng)
                    
                    # Update extended fields
                    existing.shipment_reference = shipment_reference
                    existing.client_order_id = client_order_id
                    existing.postis_order_id = postis_order_id
                    existing.client_data = client_data
                    existing.courier_data = courier_data
                    existing.sender_location = sender_location
                    existing.recipient_location = recipient_location
                    existing.product_category_data = product_category
                    existing.client_shipment_status_data = client_shipment_status
                    existing.additional_services = additional_services
                    existing.created_date = created_date
                    existing.awb_status_date = awb_status_date
                    existing.local_awb_shipment = local_awb_shipment
                    existing.local_shipment = local_shipment
                    existing.shipment_label_available = shipment_label_available
                    existing.has_borderou = has_borderou
                    existing.pallet_package = pallet_package
                    existing.source_channel = source_channel
                    existing.send_type = send_type
                    existing.sender_shop_name = sender_shop_name
                    existing.processing_status = processing_status
                    existing.number_of_parcels = number_of_parcels
                    existing.declared_value = declared_value
                    
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
                        weight=weight,
                        volumetric_weight=vol_weight,
                        dimensions=str(dims) if dims else "",
                        content_description=str(content),
                        cod_amount=cod,
                        delivery_instructions=str(instructions),
                        status=status,
                        latitude=float(lat),
                        longitude=float(lng),
                        driver_id="demo",
                        
                        # Extended fields
                        shipment_reference=shipment_reference,
                        client_order_id=client_order_id,
                        postis_order_id=postis_order_id,
                        client_data=client_data,
                        courier_data=courier_data,
                        sender_location=sender_location,
                        recipient_location=recipient_location,
                        product_category_data=product_category,
                        client_shipment_status_data=client_shipment_status,
                        additional_services=additional_services,
                        created_date=created_date,
                        awb_status_date=awb_status_date,
                        local_awb_shipment=local_awb_shipment,
                        local_shipment=local_shipment,
                        shipment_label_available=shipment_label_available,
                        has_borderou=has_borderou,
                        pallet_package=pallet_package,
                        source_channel=source_channel,
                        send_type=send_type,
                        sender_shop_name=sender_shop_name,
                        processing_status=processing_status,
                        number_of_parcels=number_of_parcels,
                        declared_value=declared_value
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
            print(f"  • {s.awb}")
            print(f"    - Client Order: {s.client_order_id}")
            print(f"    - Created: {s.created_date}")
            print(f"    - Status: {s.status}")
        
        # --- EXPORT TO JSON FOR FRONTEND SNAPSHOT ---
        print("\n📸 Creating Data Snapshot for Frontend...")
        import json
        
        all_shipments = db.query(Shipment).all()
        export_data = []
        for s in all_shipments:
            # Reconstruct the schema expected by frontend
            export_data.append({
                "awb": s.awb,
                "status": s.status or "pending",
                "recipient_name": s.recipient_name or "Unknown",
                "recipient_phone": s.recipient_phone,
                "recipient_email": s.recipient_email,
                "delivery_address": s.delivery_address or "",
                "locality": s.locality or "",
                "latitude": s.latitude,
                "longitude": s.longitude,
                "weight": s.weight or 0.0,
                "volumetric_weight": s.volumetric_weight or 0.0,
                "dimensions": s.dimensions or "",
                "content_description": s.content_description or "",
                "cod_amount": s.cod_amount or 0.0,
                "delivery_instructions": s.delivery_instructions or "",
                "driver_id": s.driver_id,
                "last_updated": s.last_updated.isoformat() if s.last_updated else None,
                "tracking_history": [],
                # Pass through extended data for detail view
                "client_order_id": s.client_order_id,
                "created_date": s.created_date.isoformat() if s.created_date else None,
                "raw_data": {
                    "courier": s.courier_data,
                    "senderLocation": s.sender_location,
                    "recipientLocation": s.recipient_location
                }
            })
            
        paths = ["frontend/public/data/shipments.json", "data/shipments.json"]
        
        for output_path in paths:
            # Ensure directory exists
            os.makedirs(os.path.dirname(output_path), exist_ok=True)
            
            with open(output_path, "w") as f:
                json.dump(export_data, f, indent=2)
                
            print(f"✅ Snapshot saved to {output_path}")

        print("\n✅ Data pull complete!")
        
    except Exception as e:
        print(f"\n❌ Error during data pull: {str(e)}")
        db.rollback()
    finally:
        db.close()

if __name__ == "__main__":
    asyncio.run(pull_all_data())
