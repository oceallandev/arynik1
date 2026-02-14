import asyncio
import os
import sys
import json
from datetime import datetime, timezone
from pathlib import Path
from dotenv import load_dotenv

# Load env early so `backend.database` picks up DATABASE_URL before creating the engine.
REPO_ROOT = Path(__file__).resolve().parent
env_path = REPO_ROOT / "backend" / ".env"
if env_path.exists():
    load_dotenv(dotenv_path=str(env_path), override=True)
else:
    # Fall back to process env (useful in CI/container deployments).
    load_dotenv(override=True)

# Ensure repo root is importable even if this script is executed from another CWD.
sys.path.insert(0, str(REPO_ROOT))

from backend.postis_client import PostisClient
from backend.models import Base, Shipment
from backend.database import engine, SessionLocal

POSTIS_BASE_URL = os.getenv("POSTIS_BASE_URL", "https://shipments.postisgate.com")
POSTIS_USER = os.getenv("POSTIS_USERNAME")
POSTIS_PASS = os.getenv("POSTIS_PASSWORD")

def _to_float(value):
    try:
        if value is None or value == "":
            return None
        return float(value)
    except Exception:
        return None


def _parse_dt(value):
    """Parse Postis timestamps into naive UTC datetimes for Postgres `timestamp without time zone`."""
    if not value:
        return None
    if isinstance(value, datetime):
        dt = value
    else:
        s = str(value).strip()
        if not s:
            return None
        try:
            # Postis returns RFC3339 with a trailing Z.
            if s.endswith("Z"):
                s = s[:-1] + "+00:00"
            dt = datetime.fromisoformat(s)
        except Exception:
            return None

    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def _normalize_status(ship_data):
    raw = (
        ship_data.get("clientShipmentStatusDescription")
        or ship_data.get("processingStatus")
        or ship_data.get("status")
        or ship_data.get("currentStatus")
        or ship_data.get("defaultClientStatus")
    )

    text = str(raw) if raw is not None else ""
    lower = text.strip().lower()

    if lower in ("livrat", "delivered"):
        return "Delivered"
    if lower in ("initial", "routed", "in transit", "in_transit", "in tranzit", "in_tranzit"):
        return "In Transit"
    if lower in ("refuzat", "refused"):
        return "Refused"

    return text or "pending"


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

    # --- FETCH FROM API ---
    print("📦 Fetching all shipments from Postis...")
    
    all_shipments = []
    page = 1
    page_size = 100
    
    while True:
        print(f"  ⬇️  Fetching page {page} (Size: {page_size})...", end="", flush=True)
        try:
            batch = await client.get_shipments(limit=page_size, page=page)
        except Exception as e:
            print(f" ❌ API Error: {e}")
            break
        
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

    # --- EXPORT TO JSON FOR FRONTEND SNAPSHOT (OFFLINE RESILIENCE) ---
    print("\n📸 Creating Data Snapshot for Frontend (Offline/Fallback)...")
    
    export_data = []
    snapshot_seen = set()
    for s in shipments:
         # Extract AWB
        awb = s.get("awb") or s.get("AWB") or s.get("trackingNumber")
        if not awb:
            continue
        if awb in snapshot_seen:
            continue
        snapshot_seen.add(awb)
        
        recipient_loc = s.get("recipientLocation") or {}
        recipient_name = recipient_loc.get("name") or s.get("recipientName") or s.get("recipient") or "Unknown"
        status = _normalize_status(s)
        
        export_data.append({
            "awb": awb,
            "status": status,
            "recipient_name": recipient_name,
            "recipient_phone": recipient_loc.get("phoneNumber") or s.get("recipientPhoneNumber") or s.get("phone") or "",
            "recipient_email": recipient_loc.get("email") or s.get("recipientEmail") or "",
            "delivery_address": recipient_loc.get("addressText") or s.get("address") or s.get("recipientAddress") or "",
            "locality": recipient_loc.get("locality") or s.get("city") or s.get("recipientLocality") or "",
            "latitude": s.get("latitude") or s.get("lat") or 0.0,
            "longitude": s.get("longitude") or s.get("lng") or 0.0,
            "weight": float(s.get("brutWeight") or s.get("weight") or 0.0),
            "volumetric_weight": float(s.get("volumetricWeight") or 0.0),
            "dimensions": s.get("dimensions") or "",
            "content_description": s.get("contentDescription") or s.get("contents") or "",
            "cod_amount": float(s.get("additionalServices", {}).get("cashOnDelivery") or s.get("cashOnDelivery") or s.get("cod") or 0.0),
            "delivery_instructions": s.get("shippingInstruction") or s.get("instructions") or "",
            "driver_id": "D002", # Default to Demo Driver for snapshot
            "last_updated": datetime.utcnow().isoformat(),
            "tracking_history": [],
            # Extended data
            "client_order_id": s.get("clientOrderId"),
            "created_date": s.get("createdDate"),
            "raw_data": {
                "courier": s.get("courier"),
                "senderLocation": s.get("senderLocation"),
                "recipientLocation": s.get("recipientLocation")
            }
        })
        
    paths = ["frontend/public/data/shipments.json", "data/shipments.json"]
    
    for output_path in paths:
        try:
            os.makedirs(os.path.dirname(output_path), exist_ok=True)
            with open(output_path, "w") as f:
                json.dump(export_data, f, indent=2)
            print(f"✅ Snapshot saved to {output_path}")
        except Exception as e:
            print(f"❌ Failed to save snapshot to {output_path}: {e}")


    # --- DB IMPORT (ATTEMPT) ---
    print("\n💾 Attempting DB Import...")
    db = None
    try:
        # Ensure tables exist
        Base.metadata.create_all(bind=engine)
        db = SessionLocal()
        print("✅ Connected to Database")
        
        imported_count = 0
        updated_count = 0
        skipped_count = 0
        duplicate_count = 0
        seen_awbs = set()

        for idx, ship_data in enumerate(shipments, 1):
            awb = None
            try:
                # Extract AWB
                awb = ship_data.get("awb") or ship_data.get("AWB") or ship_data.get("trackingNumber")
                if not awb:
                    skipped_count += 1
                    continue
                if awb in seen_awbs:
                    duplicate_count += 1
                    continue
                seen_awbs.add(awb)

                # Check exist
                existing = db.query(Shipment).filter(Shipment.awb == awb).first()

                recipient_name = (
                    ship_data.get("recipientName")
                    or ship_data.get("recipient_name")
                    or (ship_data.get("recipientLocation") or {}).get("name")
                    or ship_data.get("recipient")
                    or "Unknown"
                )
                locality = (
                    ship_data.get("recipientLocality")
                    or ship_data.get("locality")
                    or (ship_data.get("recipientLocation") or {}).get("locality")
                    or ""
                )
                status = _normalize_status(ship_data)

                weight = _to_float(ship_data.get("brutWeight") or ship_data.get("weight"))
                volumetric_weight = _to_float(ship_data.get("volumetricWeight") or ship_data.get("volumetric_weight"))
                cod_amount = _to_float(ship_data.get("cashOnDelivery") or ship_data.get("cod_amount") or ship_data.get("cod")) or 0.0

                created_date = _parse_dt(ship_data.get("createdDate") or ship_data.get("created_date"))
                has_borderou = ship_data.get("hasBorderou")

                processing_status = ship_data.get("processingStatus") or ship_data.get("processing_status")
                source_channel = ship_data.get("sourceChannel") or ship_data.get("source_channel")
                send_type = ship_data.get("sendType") or ship_data.get("send_type")
                sender_shop_name = ship_data.get("storeName") or ship_data.get("sender_shop_name")

                number_of_parcels = ship_data.get("numberOfDistinctBarcodes") or ship_data.get("number_of_parcels") or 1

                # Store a few fields as JSON for future enrichment.
                courier_data = {
                    "courierId": ship_data.get("courierId"),
                    "courierName": ship_data.get("courierName"),
                    "truckNumber": ship_data.get("truckNumber"),
                    "tripId": ship_data.get("tripId"),
                }
                client_shipment_status_data = {
                    "defaultClientStatus": ship_data.get("defaultClientStatus"),
                    "clientShipmentStatusDescription": ship_data.get("clientShipmentStatusDescription"),
                    "processingStatus": ship_data.get("processingStatus"),
                }
                product_category_data = {"name": ship_data.get("productCategory")} if ship_data.get("productCategory") else None

                if existing:
                    existing.recipient_name = recipient_name
                    existing.locality = locality
                    existing.status = status
                    existing.weight = weight
                    existing.volumetric_weight = volumetric_weight
                    existing.cod_amount = cod_amount
                    existing.created_date = created_date
                    existing.has_borderou = has_borderou
                    existing.processing_status = processing_status
                    existing.source_channel = source_channel
                    existing.send_type = send_type
                    existing.sender_shop_name = sender_shop_name
                    existing.number_of_parcels = int(number_of_parcels) if number_of_parcels else 1
                    existing.courier_data = courier_data
                    existing.client_shipment_status_data = client_shipment_status_data
                    existing.product_category_data = product_category_data
                    existing.last_updated = datetime.utcnow()
                    updated_count += 1
                else:
                    new_ship = Shipment(
                        awb=awb,
                        recipient_name=recipient_name,
                        locality=locality,
                        status=status,
                        weight=weight,
                        volumetric_weight=volumetric_weight,
                        cod_amount=cod_amount,
                        created_date=created_date,
                        has_borderou=has_borderou,
                        processing_status=processing_status,
                        source_channel=source_channel,
                        send_type=send_type,
                        sender_shop_name=sender_shop_name,
                        number_of_parcels=int(number_of_parcels) if number_of_parcels else 1,
                        courier_data=courier_data,
                        client_shipment_status_data=client_shipment_status_data,
                        product_category_data=product_category_data,
                        # Default assignment for demo/offline mode. Replace with real assignment logic later.
                        driver_id="D002",
                    )
                    db.add(new_ship)
                    imported_count += 1

                if idx % 200 == 0:
                    db.commit()

            except Exception as e:
                print(f"Row Error (awb={awb}): {e}")
                db.rollback()
                continue

        db.commit()
        print(
            f"✅ DB Import Success: {imported_count} new, {updated_count} updated. "
            f"(skipped: {skipped_count}, duplicates: {duplicate_count})"
        )
        
    except Exception as db_err:
        print(f"⚠️  Database Import Failed (Connection Issue?): {db_err}")
        print("⚠️  Running in Snapshot Mode only. App will use JSON fallbacks.")
    finally:
        if db:
            db.close()

if __name__ == "__main__":
    asyncio.run(pull_all_data())
