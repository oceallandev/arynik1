import asyncio
import sys
from sqlalchemy.orm import Session
from database import SessionLocal
import models
import schemas
from main import get_current_driver

async def main():
    print("Testing database queries...")
    db = SessionLocal()
    try:
        driver = db.query(models.Driver).first()
        if not driver:
            print("No driver found!")
            return
            
        print(f"Testing with driver: {driver.username}")
        
        # Test inserting an activity log manually
        import datetime
        from schemas import ActivityLogCreate
        req = ActivityLogCreate(
            action_type="VIEW",
            path="/activity-logs",
            method="GET",
            details="Test Visit"
        )
        
        from main import create_activity_log
        log = await create_activity_log(req=req, db=db, current_driver=driver)
        print(f"Successfully created log: {log.id}")
        
        # Test retrieving logic
        query = db.query(models.ActivityLog).order_by(models.ActivityLog.timestamp.desc()).limit(1).all()
        print(f"Successfully retrieved logs: {len(query)}")
        
        # Test Pydantic validation
        schema = [schemas.ActivityLogSchema.model_validate(q) for q in query]
        print(f"Successfully serialized logs!")
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        db.close()

if __name__ == "__main__":
    asyncio.run(main())
