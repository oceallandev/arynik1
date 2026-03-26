import sys
import json
from database import SessionLocal
import models

def print_sender_info():
    db = SessionLocal()
    try:
        ship = db.query(models.Shipment).filter(models.Shipment.sender_location != None).first()
        if not ship:
            ship = db.query(models.Shipment).first()
            if not ship:
                print("No shipments found")
                return
        
        print("AWB:", ship.awb)
        print("sender_shop_name:", ship.sender_shop_name)
        
        if ship.sender_location:
            print("sender_location:", json.dumps(ship.sender_location, indent=2))
        else:
            print("sender_location: None")
            
        if ship.client_data:
            print("client_data:", json.dumps(ship.client_data, indent=2))
        else:
            print("client_data: None")
            
    finally:
        db.close()

if __name__ == '__main__':
    print_sender_info()
