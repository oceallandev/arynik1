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
import backend.main as main_module

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

        # Endpoint defaults to driver-only live ops users.
        assert "TADM100" not in rows
        assert "TINACT1" not in rows
        assert rows["TDRV100"]["latitude"] == 46.57
        assert rows["TDRV100"]["longitude"] == 26.92

        # Two rows share the same timestamp; endpoint must keep newest row by id.
        assert rows["TDRV101"]["latitude"] == 46.71
        assert rows["TDRV101"]["longitude"] == 26.71

        assert rows["TDRV102"]["latitude"] is None
        assert rows["TDRV102"]["longitude"] is None
        assert isinstance(rows["TDRV100"].get("trail"), list)
        assert len(rows["TDRV100"].get("trail") or []) >= 2
    finally:
        for did in ("TADM100", "TDRV100", "TDRV101", "TDRV102", "TINACT1"):
            db.query(models.DriverLocation).filter(models.DriverLocation.driver_id == did).delete()
            db.query(models.Driver).filter(models.Driver.driver_id == did).delete()
        db.commit()
        db.close()


def test_tracking_request_is_auto_accepted_without_driver_confirmation():
    db = database.SessionLocal()
    admin_password = "AdminTrack123"
    try:
        for did in ("TADM200", "TDRV200"):
            db.query(models.Driver).filter(models.Driver.driver_id == did).delete()
        db.commit()

        db.add_all([
            models.Driver(
                driver_id="TADM200",
                name="Admin Tracker",
                username="test_admin_tracking",
                password_hash=driver_manager.get_password_hash(admin_password),
                role="Admin",
                active=True,
            ),
            models.Driver(
                driver_id="TDRV200",
                name="Driver Tracked",
                username="test_driver_tracked",
                password_hash=driver_manager.get_password_hash("x"),
                role="Driver",
                active=True,
            ),
        ])
        db.commit()

        login = client.post(
            "/login",
            data={"username": "test_admin_tracking", "password": admin_password},
        )
        assert login.status_code == 200, login.text
        token = login.json().get("access_token")
        assert token

        create = client.post(
            "/tracking/requests",
            json={"driver_id": "TDRV200", "duration_sec": 900},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert create.status_code == 201, create.text
        body = create.json()
        assert str(body.get("status")) == "Accepted"
        assert body.get("accepted_at") is not None
        assert str(body.get("target_driver_id")) == "TDRV200"
    finally:
        try:
            db.query(models.TrackingRequest).filter(
                models.TrackingRequest.created_by_user_id.in_(("TADM200", "TDRV200"))
            ).delete(synchronize_session=False)
            db.query(models.TrackingRequest).filter(
                models.TrackingRequest.target_driver_id.in_(("TADM200", "TDRV200"))
            ).delete(synchronize_session=False)
        except Exception:
            pass
        for did in ("TADM200", "TDRV200"):
            db.query(models.DriverLocation).filter(models.DriverLocation.driver_id == did).delete()
            db.query(models.Driver).filter(models.Driver.driver_id == did).delete()
        db.commit()
        db.close()


def test_maps_route_optimize_uses_google_backend(monkeypatch):
    db = database.SessionLocal()
    admin_password = "AdminMaps123"
    admin_id = "TMAPADM1"
    try:
        db.query(models.Driver).filter(models.Driver.driver_id == admin_id).delete()
        db.commit()
        db.add(
            models.Driver(
                driver_id=admin_id,
                name="Admin Maps",
                username="test_admin_maps_opt",
                password_hash=driver_manager.get_password_hash(admin_password),
                role="Admin",
                active=True,
            )
        )
        db.commit()

        async def fake_google_optimize_route(*, origin, stops, return_to_origin=True):
            _ = origin, stops, return_to_origin
            return {
                "optimized_order": [1, 0],
                "geometry": {"type": "LineString", "coordinates": [[26.10, 44.42], [26.12, 44.44]]},
                "distance_m": 12345.0,
                "duration_s": 2345.0,
                "duration_no_traffic_s": 2100.0,
                "delay_s": 245.0,
                "provider": "google_traffic",
            }

        monkeypatch.setattr(main_module, "_google_optimize_route", fake_google_optimize_route)

        login = client.post(
            "/login",
            data={"username": "test_admin_maps_opt", "password": admin_password},
        )
        assert login.status_code == 200, login.text
        token = login.json().get("access_token")
        assert token

        res = client.post(
            "/maps/route-optimize",
            json={
                "origin": {"lat": 44.4268, "lon": 26.1025},
                "stops": [
                    {"lat": 46.56, "lon": 26.91},
                    {"lat": 46.57, "lon": 26.92},
                ],
                "return_to_origin": True,
            },
            headers={"Authorization": f"Bearer {token}"},
        )
        assert res.status_code == 200, res.text
        body = res.json()
        assert body.get("optimized_order") == [1, 0]
        assert body.get("provider") == "google_traffic"
        assert float(body.get("distance_m") or 0) > 0
    finally:
        db.query(models.Driver).filter(models.Driver.driver_id == admin_id).delete()
        db.commit()
        db.close()


def test_sync_drivers_reports_real_driver_counts_not_all_users():
    db = database.SessionLocal()
    admin_password = "AdminSync123"
    ids = ("TSYNCADM", "TSYNCDRV", "TSYNCDSP", "TSYNCCUR")
    try:
        for did in ids:
            db.query(models.Driver).filter(models.Driver.driver_id == did).delete()
        db.commit()

        db.add_all([
            models.Driver(
                driver_id="TSYNCADM",
                name="Sync Admin",
                username="sync_admin",
                password_hash=driver_manager.get_password_hash(admin_password),
                role="Admin",
                active=True,
            ),
            models.Driver(
                driver_id="TSYNCDRV",
                name="Driver Active",
                username="sync_driver",
                password_hash=driver_manager.get_password_hash("x"),
                role="Driver",
                active=True,
            ),
            models.Driver(
                driver_id="TSYNCDSP",
                name="Dispatcher",
                username="sync_dispatcher",
                password_hash=driver_manager.get_password_hash("x"),
                role="Dispatcher",
                active=True,
            ),
            models.Driver(
                driver_id="TSYNCCUR",
                name="Curier Inactiv",
                username="sync_curier",
                password_hash=driver_manager.get_password_hash("x"),
                role="Curier",  # alias that must count as Driver
                active=False,
            ),
        ])
        db.commit()

        login = client.post(
            "/login",
            data={"username": "sync_admin", "password": admin_password},
        )
        assert login.status_code == 200, login.text
        token = login.json().get("access_token")
        assert token

        res = client.post("/sync-drivers", headers={"Authorization": f"Bearer {token}"})
        assert res.status_code == 200, res.text
        body = res.json()
        assert int(body.get("users_total") or 0) >= 4
        assert int(body.get("drivers_total") or 0) >= 2
        assert int(body.get("drivers_active") or 0) >= 1
        # Must not report all users as drivers.
        assert int(body.get("drivers_total") or 0) < int(body.get("users_total") or 0)
    finally:
        for did in ids:
            db.query(models.Driver).filter(models.Driver.driver_id == did).delete()
        db.commit()
        db.close()


def test_update_awb_reschedule_requires_date_time():
    db = database.SessionLocal()
    driver_id = "TUPD701"
    username = "test_update_reschedule"
    password = "UpdatePass701"
    awb = "TSTUPDRESCHED701"
    try:
        db.query(models.Shipment).filter(models.Shipment.awb == awb).delete()
        db.query(models.Driver).filter(models.Driver.driver_id == driver_id).delete()
        db.commit()

        db.add(
            models.Driver(
                driver_id=driver_id,
                name="Test Update Reschedule",
                username=username,
                password_hash=driver_manager.get_password_hash(password),
                role="Driver",
                active=True,
            )
        )
        db.add(
            models.Shipment(
                awb=awb,
                status="Out for delivery",
                recipient_name="Recipient",
                locality="Bacau",
                delivery_address="Bacau",
            )
        )
        db.commit()

        login = client.post("/login", data={"username": username, "password": password})
        assert login.status_code == 200, login.text
        token = login.json().get("access_token")
        assert token

        res = client.post(
            "/update-awb",
            json={
                "awb": awb,
                "event_id": "7",
                "payload": {
                    "locality": "Bacau",
                    "ndr": {"reason_code": "RECIPIENT_NOT_HOME"},
                },
            },
            headers={"Authorization": f"Bearer {token}"},
        )
        assert res.status_code == 400, res.text
        assert "Reschedule date/time is required" in str(res.json().get("detail") or "")
    finally:
        db.query(models.Shipment).filter(models.Shipment.awb == awb).delete()
        db.query(models.LogEntry).filter(models.LogEntry.awb == awb).delete()
        db.query(models.Driver).filter(models.Driver.driver_id == driver_id).delete()
        db.commit()
        db.close()


def test_update_awb_refused_livrat_maps_to_expeditie_returnata(monkeypatch):
    db = database.SessionLocal()
    driver_id = "TUPD702"
    username = "test_update_refused"
    password = "UpdatePass702"
    awb = "TSTUPDREFUSED702"
    captured = {"event_id": None}
    try:
        db.query(models.Shipment).filter(models.Shipment.awb == awb).delete()
        db.query(models.Driver).filter(models.Driver.driver_id == driver_id).delete()
        db.commit()

        db.add(
            models.Driver(
                driver_id=driver_id,
                name="Test Update Refused",
                username=username,
                password_hash=driver_manager.get_password_hash(password),
                role="Driver",
                active=True,
            )
        )
        db.add(
            models.Shipment(
                awb=awb,
                status="Refuzare colet",
                recipient_name="Recipient",
                locality="Iasi",
                delivery_address="Iasi",
            )
        )
        db.commit()

        async def fake_update(identifier, event_id, details):
            _ = identifier, details
            captured["event_id"] = str(event_id)
            return {"reference": "TEST-REF-1"}

        monkeypatch.setattr(main_module.p_client, "update_status_by_awb_or_client_order_id", fake_update)

        login = client.post("/login", data={"username": username, "password": password})
        assert login.status_code == 200, login.text
        token = login.json().get("access_token")
        assert token

        # First call: no return proof photo => blocked.
        fail_res = client.post(
            "/update-awb",
            json={
                "awb": awb,
                "event_id": "2",
                "payload": {
                    "locality": "Iasi",
                    "pod": {
                        "signature": {"data_url": "data:image/png;base64,AAA"},
                    },
                },
            },
            headers={"Authorization": f"Bearer {token}"},
        )
        assert fail_res.status_code == 400, fail_res.text
        assert "Return product photo is required" in str(fail_res.json().get("detail") or "")

        # Second call: photo provided => mapped to event 4 and accepted.
        ok_res = client.post(
            "/update-awb",
            json={
                "awb": awb,
                "event_id": "2",
                "payload": {
                    "locality": "Iasi",
                    "pod": {
                        "photo": {"data_url": "data:image/jpeg;base64,BBB"},
                        "signature": {"data_url": "data:image/png;base64,AAA"},
                    },
                },
            },
            headers={"Authorization": f"Bearer {token}"},
        )
        assert ok_res.status_code == 200, ok_res.text
        body = ok_res.json()
        assert str(body.get("effective_event_id") or "") == "4"
        assert str(captured.get("event_id") or "") == "4"
    finally:
        db.query(models.Shipment).filter(models.Shipment.awb == awb).delete()
        db.query(models.LogEntry).filter(models.LogEntry.awb == awb).delete()
        db.query(models.Driver).filter(models.Driver.driver_id == driver_id).delete()
        db.commit()
        db.close()


def test_routes_plan_list_includes_stale_awb_indicator():
    db = database.SessionLocal()
    admin_id = "TROUTE901"
    username = "test_route_stale"
    password = "RoutePass901"
    awb_old = "TROUTEAWBOLD901"
    awb_new = "TROUTEAWBNEW901"
    plan_date = "2026-03-11"
    try:
        main_module.route_planning_service.ensure_route_plans_schema(db)
        db.query(models.RoutePlan).filter(models.RoutePlan.plan_date == plan_date).delete()
        db.query(models.Shipment).filter(models.Shipment.awb.in_([awb_old, awb_new])).delete()
        db.query(models.Driver).filter(models.Driver.driver_id == admin_id).delete()
        db.commit()

        db.add(
            models.Driver(
                driver_id=admin_id,
                name="Admin Route Stale",
                username=username,
                password_hash=driver_manager.get_password_hash(password),
                role="Admin",
                active=True,
            )
        )
        db.add_all([
            models.Shipment(
                awb=awb_old,
                status="Out for delivery",
                recipient_name="Old",
                locality="Bacau",
                delivery_address="Bacau",
                awb_status_date=datetime.utcnow() - timedelta(days=6),
            ),
            models.Shipment(
                awb=awb_new,
                status="Out for delivery",
                recipient_name="New",
                locality="Bacau",
                delivery_address="Bacau",
                awb_status_date=datetime.utcnow() - timedelta(hours=8),
            ),
        ])
        db.add(
            models.RoutePlan(
                plan_date=plan_date,
                county="Bacau",
                route_index=1,
                name="Bacau",
                status="Draft",
                awbs=[awb_old, awb_new],
                awb_count=2,
                created_at=datetime.utcnow(),
                updated_at=datetime.utcnow(),
            )
        )
        db.commit()

        login = client.post("/login", data={"username": username, "password": password})
        assert login.status_code == 200, login.text
        token = login.json().get("access_token")
        assert token

        res = client.get(
            "/routes/plans",
            params={"plan_date": plan_date},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert res.status_code == 200, res.text
        rows = res.json()
        assert isinstance(rows, list) and rows
        row = rows[0]
        data = row.get("data") or {}
        assert int(data.get("stale_awb_count") or 0) == 1
        assert int(data.get("stale_awb_threshold_days") or 0) == 4
    finally:
        db.query(models.RoutePlan).filter(models.RoutePlan.plan_date == plan_date).delete()
        db.query(models.Shipment).filter(models.Shipment.awb.in_([awb_old, awb_new])).delete()
        db.query(models.Driver).filter(models.Driver.driver_id == admin_id).delete()
        db.commit()
        db.close()
