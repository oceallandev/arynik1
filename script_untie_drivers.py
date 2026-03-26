import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from backend.models import Driver

# Make sure we use the production env if any, or standard local
os.environ["ENV"] = "production"

# Import after env
from backend.database import DATABASE_URL

print(f"Connecting to {DATABASE_URL}...")
engine = create_engine(DATABASE_URL)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

def run():
    db = SessionLocal()
    try:
        count = db.query(Driver).update({
            Driver.truck_plate: None,
            Driver.helper_name: None,
            Driver.phone_number: None,
            Driver.phone_norm: None
        })
        db.commit()
        print(f"Successfully untied {count} drivers from helpers, phones, and vehicles.")
    except Exception as e:
        print(f"Error: {e}")
        db.rollback()
    finally:
        db.close()

if __name__ == "__main__":
    run()
