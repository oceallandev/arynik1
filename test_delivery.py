import os, sys, traceback
os.environ["DATABASE_URL"] = "sqlite:///./arynik_db.sqlite"
sys.path.append("backend")

def test():
    try:
        import database
        import models
        from sqlalchemy.orm import Session
        
        # Test just the query that main.py does
        db = database.SessionLocal()
        
        query = (
            db.query(models.RouteRunStop, models.RouteRun, models.Shipment, models.Driver)
            .join(models.RouteRun, models.RouteRunStop.run_id == models.RouteRun.id)
            .outerjoin(models.Shipment, models.RouteRunStop.awb == models.Shipment.awb)
            .outerjoin(models.Driver, models.RouteRun.driver_id == models.Driver.driver_id)
            .filter(models.RouteRunStop.state.in_(["Done", "Completed"]))
        )
        rows = query.limit(2).all()
        for stop, run, ship, driver in rows:
            print("Row:", stop.id, run.id, getattr(ship, 'awb', None))
            
    except Exception as e:
        traceback.print_exc()

test()
