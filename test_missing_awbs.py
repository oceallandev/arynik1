import os
import sys

from backend.database import SessionLocal
from backend.services import route_planning_service
from backend.models import Shipment

def test_diagnose():
    db = SessionLocal()
    target_date = "2026-03-26"
    print("Fetching shipments...")
    shipments = route_planning_service._load_shipments_for_planning(db)
    
    bacau_ships = [s for s in shipments if route_planning_service.infer_shipment_county(s) == "Bacău"]
    print(f"Found {len(bacau_ships)} shipments mapped to Bacău.")
    
    for s in bacau_ships:
        cl = route_planning_service.classify_shipment_for_routing(s, plan_date=target_date)
        if not cl.get("eligible"):
            awb = s.awb
            status = getattr(s, "status", None)
            reason = cl.get("reason", "unknown")
            routing_raw = (s.raw_data or {}).get("routing", {}) if isinstance(s.raw_data, dict) else {}
            old_plan = routing_raw.get("route_plan_id")
            
            print(f"AWB: {awb} | Ineligible. Reason: {reason} | Status: {status} | old_plan: {old_plan}")
    
    print("\nDrafting Route Plans for today for Bacău...")
    summary = route_planning_service.generate_daily_route_plans(db, plan_date=target_date, county_filter="Bacău")
    print(f"Summary generated: {summary.get('generated_count')} generated. Counties updated: {summary.get('updated_routes')}")
    
if __name__ == "__main__":
    test_diagnose()
