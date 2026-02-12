import pandas as pd
import logging
from typing import List
from sqlalchemy.orm import Session
from .models import Driver
from .database import SessionLocal
import os
import hashlib

logger = logging.getLogger(__name__)

class DriverManager:
    def __init__(self, sheet_url: str):
        self.sheet_url = sheet_url

    def fetch_drivers_from_sheet(self) -> pd.DataFrame:
        try:
            # Convert regular Google Sheet URL to CSV export URL if necessary
            if "edit#gid=" in self.sheet_url:
                csv_url = self.sheet_url.replace("edit#gid=", "export?format=csv&gid=")
            elif "/edit" in self.sheet_url:
                csv_url = self.sheet_url.replace("/edit", "/export?format=csv")
            else:
                csv_url = self.sheet_url
                
            df = pd.read_csv(csv_url)
            required_cols = ["driver_id", "name", "username", "password", "role", "active"]
            for col in required_cols:
                if col not in df.columns:
                    raise Exception(f"Missing required column: {col}")
            return df
        except Exception as e:
            logger.error(f"Error fetching drivers from sheet: {str(e)}")
            raise e

    def sync_drivers(self, db: Session):
        try:
            df = self.fetch_drivers_from_sheet()
            for _, row in df.iterrows():
                driver = db.query(Driver).filter(Driver.driver_id == str(row["driver_id"])).first()
                if not driver:
                    driver = Driver(
                        driver_id=str(row["driver_id"]),
                        name=row["name"],
                        username=row["username"],
                        # In production, use bcrypt. Here we just show a placeholder hash logic if sheet has plain text
                        password_hash=row["password"], # Assuming hashed in sheet or handle here
                        role=row["role"],
                        active=bool(row["active"])
                    )
                    db.add(driver)
                else:
                    driver.name = row["name"]
                    driver.username = row["username"]
                    driver.role = row["role"]
                    driver.active = bool(row["active"])
            db.commit()
            logger.info("Drivers synced successfully from Google Sheet")
        except Exception as e:
            logger.error(f"Driver sync failed: {str(e)}")
            db.rollback()

def get_password_hash(password: str):
    # Simple hash for demonstration, use passlib/bcrypt in real prod
    return hashlib.sha256(password.encode()).hexdigest()

def verify_password(plain_password: str, hashed_password: str):
    return get_password_hash(plain_password) == hashed_password
