import pandas as pd
import logging
from sqlalchemy.orm import Session
try:
    from .models import Driver
except ImportError:  # pragma: no cover
    from models import Driver
import hashlib
try:
    from . import authz
except ImportError:  # pragma: no cover
    import authz

try:
    from .services.phone_service import normalize_phone
except Exception:  # pragma: no cover
    try:
        from services.phone_service import normalize_phone  # type: ignore
    except Exception:
        normalize_phone = None  # type: ignore

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

            # Optional allocation columns (kept backward-compatible with older sheets).
            col_map = {str(c).strip().casefold(): c for c in df.columns}

            def _find_col(*keys: str):
                for key in keys:
                    col = col_map.get(str(key).strip().casefold())
                    if col:
                        return col
                return None

            def _cell_str(value):
                if value is None:
                    return None
                s = str(value).strip()
                if not s or s.lower() == "nan":
                    return None
                return s

            truck_plate_col = _find_col("truck_plate", "truck_number", "trucknumber", "vehicle_plate", "vehicle")
            phone_col = _find_col("truck_phone", "truck_phone_number", "phone_number", "mobile", "phone")
            helper_col = _find_col("helper_name", "helper", "assistant", "assistant_name")
            for _, row in df.iterrows():
                driver_id = str(row["driver_id"]).strip()
                driver = db.query(Driver).filter(Driver.driver_id == driver_id).first()

                raw_password = row.get("password", "")
                password_value = "" if raw_password is None else str(raw_password).strip()
                if password_value.lower() == "nan":
                    password_value = ""

                password_hash = None
                if password_value:
                    password_hash = password_value.lower() if _looks_like_sha256(password_value) else get_password_hash(password_value)

                raw_role = row.get("role", "")
                role_value = "" if raw_role is None else str(raw_role).strip()
                role_value = "" if role_value.lower() == "nan" else role_value
                role_norm = authz.normalize_role(role_value)
                if role_norm and role_norm not in authz.VALID_ROLES:
                    logger.warning(f"Unknown role '{role_value}' for driver_id={driver_id} (normalized='{role_norm}').")

                active_value = _parse_active(row.get("active", True))

                if not driver:
                    if not password_hash:
                        logger.warning(f"Skipping driver_id={driver_id}: missing password in sheet.")
                        continue
                    driver = Driver(
                        driver_id=driver_id,
                        name=row["name"],
                        username=row["username"],
                        password_hash=password_hash,
                        role=role_norm,
                        active=active_value,
                    )
                    db.add(driver)
                else:
                    driver.name = row["name"]
                    driver.username = row["username"]
                    driver.role = role_norm
                    driver.active = active_value
                    if password_hash:
                        driver.password_hash = password_hash

                # Truck allocation fields:
                # - mobile phone number is attached to the truck
                # - the driver logs in with their credentials and gets the allocated truck details
                if truck_plate_col:
                    driver.truck_plate = _cell_str(row.get(truck_plate_col))
                if phone_col:
                    phone_val = _cell_str(row.get(phone_col))
                    driver.phone_number = phone_val
                    if callable(normalize_phone):
                        driver.phone_norm = normalize_phone(phone_val) if phone_val else None
                if helper_col:
                    driver.helper_name = _cell_str(row.get(helper_col))
            db.commit()
            logger.info("Drivers synced successfully from Google Sheet")
        except Exception as e:
            logger.error(f"Driver sync failed: {str(e)}")
            db.rollback()

def get_password_hash(password: str):
    # Simple hash for demonstration, use passlib/bcrypt in real prod
    return hashlib.sha256(password.encode()).hexdigest()

def verify_password(plain_password: str, hashed_password: str):
    return get_password_hash(plain_password) == (hashed_password or "").strip().lower()


def _looks_like_sha256(value: str) -> bool:
    s = (value or "").strip()
    if len(s) != 64:
        return False
    try:
        int(s, 16)
    except ValueError:
        return False
    return True


def _parse_active(value) -> bool:
    if value is None:
        return False
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        try:
            return int(value) != 0
        except Exception:
            return False
    s = str(value).strip().lower()
    if s in ("true", "t", "yes", "y", "1", "on", "da", "activ", "active"):
        return True
    if s in ("false", "f", "no", "n", "0", "off", "nu", "inactiv", "inactive"):
        return False
    # Best-effort fallback: non-empty strings are treated as True by many sheet exports.
    return bool(s)
