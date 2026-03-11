import os
import tempfile
from datetime import datetime, timedelta

from fastapi.testclient import TestClient

# Force tests to use a local SQLite DB, not backend/.env.
_tmp_db = tempfile.NamedTemporaryFile(prefix="arynik-test-", suffix=".db", delete=False)
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from backend import database, driver_manager, models
from backend.database import engine
from backend.models import Base

Base.metadata.create_all(bind=engine)

from backend.main import app

client = TestClient(app)

def test_login_fail():
    response = client.post("/login", data={"username": "wrong", "password": "wrong"})
    assert response.status_code == 401

def test_status_options_no_auth():
    response = client.get("/status-options")
    assert response.status_code == 401


def test_live_drivers_returns_latest_location_per_driver():
    db = database.SessionLocal()
    now = datetime.utcnow().replace(microsecond=0)
    shared_ts = now - timedelta(minutes=1)
    admin_password = "AdminPass123"
    try:
        for did in ("TADM100", "TDRV100", "TDRV101", "TDRV102", "TINACT1"):
            db.query(models.DriverLocation).filter(models.DriverLocation.driver_id == did).delete()
            db.query(models.Driver).filter(models.Driver.driver_id == did).delete()
        db.commit()

        db.add_all([
            models.Driver(
                driver_id="TADM100",
                name="Test Admin",
                username="test_admin_liveops",
                password_hash=driver_manager.get_password_hash(admin_password),
                role="Admin",
                active=True,
            ),
            models.Driver(
                driver_id="TDRV100",
                name="Driver Latest",
                username="test_driver_latest",
                password_hash=driver_manager.get_password_hash("x"),
                role="Driver",
                active=True,
            ),
            models.Driver(
                driver_id="TDRV101",
                name="Driver Same Timestamp",
                username="test_driver_same_ts",
                password_hash=driver_manager.get_password_hash("x"),
                role="Driver",
                active=True,
            ),
            models.Driver(
                driver_id="TDRV102",
                name="Driver No Location",
                username="test_driver_no_loc",
                password_hash=driver_manager.get_password_hash("x"),
                role="Driver",
                active=True,
            ),
            models.Driver(
                driver_id="TINACT1",
                name="Inactive Driver",
                username="test_driver_inactive",
                password_hash=driver_manager.get_password_hash("x"),
                role="Driver",
                active=False,
            ),
        ])
        db.commit()

        db.add_all([
            models.DriverLocation(
                driver_id="TDRV100",
                latitude=46.56,
                longitude=26.91,
                timestamp=now - timedelta(hours=1),
            ),
            models.DriverLocation(
                driver_id="TDRV100",
                latitude=46.57,
                longitude=26.92,
                timestamp=now,
            ),
            models.DriverLocation(
                driver_id="TDRV101",
                latitude=46.70,
                longitude=26.70,
                timestamp=shared_ts,
            ),
            models.DriverLocation(
                driver_id="TDRV101",
                latitude=46.71,
                longitude=26.71,
                timestamp=shared_ts,
            ),
        ])
        db.commit()

        login = client.post(
            "/login",
            data={"username": "test_admin_liveops", "password": admin_password},
        )
        assert login.status_code == 200, login.text
        token = login.json().get("access_token")
        assert token

        res = client.get("/live/drivers", headers={"Authorization": f"Bearer {token}"})
        assert res.status_code == 200, res.text
        body = res.json()
        rows = {str(item.get("driver_id")): item for item in (body.get("drivers") or [])}

        assert "TINACT1" not in rows
        assert rows["TDRV100"]["latitude"] == 46.57
        assert rows["TDRV100"]["longitude"] == 26.92

        # Two rows share the same timestamp; endpoint must keep newest row by id.
        assert rows["TDRV101"]["latitude"] == 46.71
        assert rows["TDRV101"]["longitude"] == 26.71

        assert rows["TDRV102"]["latitude"] is None
        assert rows["TDRV102"]["longitude"] is None
    finally:
        for did in ("TADM100", "TDRV100", "TDRV101", "TDRV102", "TINACT1"):
            db.query(models.DriverLocation).filter(models.DriverLocation.driver_id == did).delete()
            db.query(models.Driver).filter(models.Driver.driver_id == did).delete()
        db.commit()
        db.close()
