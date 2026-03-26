import sys
import json
from database import SessionLocal
import models
from services.route_aviz_service import issue_route_aviz, route_aviz_to_dict

def test_issue():
    db = SessionLocal()
    try:
        # Get a route plan that has AWBs
        plan = db.query(models.RoutePlan).filter(models.RoutePlan.awbs != '[]').first()
        if not plan:
            print("No route plan found with AWBs")
            return
            
        print("Using RoutePlan ID:", plan.id)
        
        # Issue aviz
        aviz = issue_route_aviz(db, plan=plan)
        
        # Don't commit so we don't mess up DB
        data = route_aviz_to_dict(aviz)
        
        # Print issuer from generated data
        print("Isset data:", json.dumps(data.get("data", {}).get("issuer"), indent=2))
        
    finally:
        db.close()

if __name__ == '__main__':
    test_issue()
