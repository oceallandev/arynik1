import os
import tempfile
import time
from datetime import datetime, timedelta

from fastapi.testclient import TestClient

# Force tests to use a local SQLite DB, not backend/.env.
_tmp_db = tempfile.NamedTemporaryFile(prefix="arynik-test-", suffix=".db", delete=False)
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from backend import database, driver_manager, models
from backend.database import engine
from backend.models import Base
from backend.services import postis_sync_service
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


def test_admin_can_set_provider_secrets_without_exposing_raw_values(monkeypatch):
    db = database.SessionLocal()
    admin_id = "TSECRADM1"
    username = "test_secrets_admin"
    password = "SecretsPass1"
    tmp_env = tempfile.NamedTemporaryFile(prefix="arynik-secrets-", suffix=".env", delete=False)
    tmp_env.close()
    try:
        db.query(models.Driver).filter(models.Driver.driver_id == admin_id).delete()
        db.commit()
        db.add(
            models.Driver(
                driver_id=admin_id,
                name="Secrets Admin",
                username=username,
                password_hash=driver_manager.get_password_hash(password),
                role="Admin",
                active=True,
            )
        )
        db.commit()

        monkeypatch.setattr(main_module, "_SERVER_ENV_FILE_PATH", tmp_env.name)
        os.environ.pop("OPENAI_API_KEY", None)
        os.environ.pop("ELEVENLABS_API_KEY", None)

        login = client.post("/login", data={"username": username, "password": password})
        assert login.status_code == 200, login.text
        token = login.json().get("access_token")
        assert token

        read_before = client.get(
            "/admin/provider-secrets",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert read_before.status_code == 200, read_before.text
        assert read_before.json().get("openai_api_key", {}).get("configured") is False

        res = client.post(
            "/admin/provider-secrets",
            json={
                "openai_api_key": "sk-test-openai-1234567890",
                "elevenlabs_api_key": "el-test-1234567890",
                "persist_to_env": True,
            },
            headers={"Authorization": f"Bearer {token}"},
        )
        assert res.status_code == 200, res.text
        body = res.json()
        assert body.get("ok") is True
        assert body.get("saved_to_env") is True
        assert body.get("openai_api_key", {}).get("configured") is True
        assert body.get("elevenlabs_api_key", {}).get("configured") is True
        assert "sk-test-openai-1234567890" not in str(body)
        assert "el-test-1234567890" not in str(body)

        assert os.environ.get("OPENAI_API_KEY") == "sk-test-openai-1234567890"
        assert os.environ.get("ELEVENLABS_API_KEY") == "el-test-1234567890"

        with open(tmp_env.name, "r", encoding="utf-8") as fh:
            env_text = fh.read()
        assert "OPENAI_API_KEY" in env_text
        assert "ELEVENLABS_API_KEY" in env_text
    finally:
        os.environ.pop("OPENAI_API_KEY", None)
        os.environ.pop("ELEVENLABS_API_KEY", None)
        db.query(models.Driver).filter(models.Driver.driver_id == admin_id).delete()
        db.commit()
        db.close()


def test_non_admin_cannot_update_provider_secrets():
    db = database.SessionLocal()
    driver_id = "TSECRDRV1"
    username = "test_secrets_driver"
    password = "SecretsPass2"
    try:
        db.query(models.Driver).filter(models.Driver.driver_id == driver_id).delete()
        db.commit()
        db.add(
            models.Driver(
                driver_id=driver_id,
                name="Secrets Driver",
                username=username,
                password_hash=driver_manager.get_password_hash(password),
                role="Driver",
                active=True,
            )
        )
        db.commit()

        login = client.post("/login", data={"username": username, "password": password})
        assert login.status_code == 200, login.text
        token = login.json().get("access_token")
        assert token

        res = client.post(
            "/admin/provider-secrets",
            json={"openai_api_key": "sk-not-allowed"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert res.status_code == 403, res.text
    finally:
        db.query(models.Driver).filter(models.Driver.driver_id == driver_id).delete()
        db.commit()
        db.close()


def test_admin_notes_status_create_and_update():
    db = database.SessionLocal()
    admin_id = "TNOTEADM1"
    username = "test_notes_admin"
    password = "NotesPass1"
    try:
        db.query(models.AdminNote).filter(models.AdminNote.created_by_user_id == admin_id).delete(synchronize_session=False)
        db.query(models.Driver).filter(models.Driver.driver_id == admin_id).delete()
        db.commit()
        db.add(
            models.Driver(
                driver_id=admin_id,
                name="Notes Admin",
                username=username,
                password_hash=driver_manager.get_password_hash(password),
                role="Admin",
                active=True,
            )
        )
        db.commit()

        login = client.post("/login", data={"username": username, "password": password})
        assert login.status_code == 200, login.text
        token = login.json().get("access_token")
        assert token

        created = client.post(
            "/admin/notes",
            json={"text": "Test note status", "status": "in lucru"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert created.status_code == 201, created.text
        created_body = created.json()
        assert created_body.get("status") == "In Progress"
        note_id = int(created_body.get("id"))

        updated = client.patch(
            f"/admin/notes/{note_id}",
            json={"status": "rezolvat"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert updated.status_code == 200, updated.text
        updated_body = updated.json()
        assert updated_body.get("status") == "Resolved"

        listed = client.get(
            "/admin/notes",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert listed.status_code == 200, listed.text
        rows = listed.json()
        match = next((row for row in rows if int(row.get("id") or 0) == note_id), None)
        assert match is not None
        assert match.get("status") == "Resolved"
    finally:
        db.query(models.AdminNote).filter(models.AdminNote.created_by_user_id == admin_id).delete(synchronize_session=False)
        db.query(models.Driver).filter(models.Driver.driver_id == admin_id).delete()
        db.commit()
        db.close()


def test_geocode_sync_filters_only_routing_eligible_awbs():
    db = database.SessionLocal()
    awb_ok = "TGEOROUTE1"
    awb_skip = "TGEOROUTE2"
    try:
        for awb in (awb_ok, awb_skip):
            db.query(models.Shipment).filter(models.Shipment.awb == awb).delete()
        db.commit()

        db.add_all([
            models.Shipment(
                awb=awb_ok,
                status="In depot",
                delivery_address="Bacau, Str. Test 1",
                locality="Bacau",
                recipient_location={"county": "Bacau"},
            ),
            models.Shipment(
                awb=awb_skip,
                status="Delivered",
                delivery_address="Bacau, Str. Test 2",
                locality="Bacau",
                recipient_location={"county": "Bacau"},
            ),
        ])
        db.commit()

        filtered = postis_sync_service._db_filter_awbs_routing_eligible(awbs=[awb_ok, awb_skip], limit=20)
        assert awb_ok in filtered
        assert awb_skip not in filtered
    finally:
        for awb in (awb_ok, awb_skip):
            db.query(models.Shipment).filter(models.Shipment.awb == awb).delete()
        db.commit()
        db.close()


def test_admin_maps_provider_config_credit_and_usage(monkeypatch):
    db = database.SessionLocal()
    admin_id = "TMAPSADM1"
    username = "test_maps_admin"
    password = "MapsPass1"
    tmp_env = tempfile.NamedTemporaryFile(prefix="arynik-maps-", suffix=".env", delete=False)
    tmp_env.close()
    try:
        db.query(models.Driver).filter(models.Driver.driver_id == admin_id).delete()
        db.commit()
        db.add(
            models.Driver(
                driver_id=admin_id,
                name="Maps Admin",
                username=username,
                password_hash=driver_manager.get_password_hash(password),
                role="Admin",
                active=True,
            )
        )
        db.commit()

        monkeypatch.setattr(main_module, "_SERVER_ENV_FILE_PATH", tmp_env.name)

        login = client.post("/login", data={"username": username, "password": password})
        assert login.status_code == 200, login.text
        token = login.json().get("access_token")
        assert token

        cfg = client.post(
            "/admin/maps-provider-config",
            json={
                "maps_mode": "platform",
                "platform_google_maps_api_key": "g-platform-key-123456",
                "persist_to_env": True,
            },
            headers={"Authorization": f"Bearer {token}"},
        )
        assert cfg.status_code == 200, cfg.text
        body_cfg = cfg.json()
        assert body_cfg.get("maps_mode") == "platform"
        assert body_cfg.get("platform_google_maps_api_key", {}).get("configured") is True
        assert "g-platform-key-123456" not in str(body_cfg)

        topup = client.post(
            "/admin/maps-provider-credit",
            json={"amount": 50.0, "note": "test topup"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert topup.status_code == 200, topup.text
        assert float(topup.json().get("platform_credit_balance") or 0) >= 50.0

        async def fake_route_metrics(points, api_key=None):
            _ = points, api_key
            return {
                "geometry": {"type": "LineString", "coordinates": [[26.1, 44.4], [26.2, 44.5]]},
                "distance_m": 1200.0,
                "duration_s": 600.0,
                "duration_no_traffic_s": 540.0,
                "delay_s": 60.0,
                "provider": "google_traffic",
            }

        monkeypatch.setattr(main_module, "_google_route_metrics", fake_route_metrics)

        route_res = client.post(
            "/maps/route-metrics",
            json={"points": [{"lat": 44.4268, "lon": 26.1025}, {"lat": 44.4368, "lon": 26.1125}]},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert route_res.status_code == 200, route_res.text

        read_after = client.get(
            "/admin/maps-provider-config",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert read_after.status_code == 200, read_after.text
        body_after = read_after.json()
        assert int(body_after.get("platform_usage_requests") or 0) >= 1
        assert float(body_after.get("platform_usage_cost") or 0) > 0
        assert float(body_after.get("platform_credit_balance") or 0) < 50.0
    finally:
        db.query(models.MapsProviderUsage).filter(models.MapsProviderUsage.owner_user_id == admin_id).delete(synchronize_session=False)
        db.query(models.MapsProviderConfig).filter(models.MapsProviderConfig.owner_user_id == admin_id).delete(synchronize_session=False)
        db.query(models.Driver).filter(models.Driver.driver_id == admin_id).delete()
        db.commit()
        db.close()


def test_assistant_ask_returns_context_awb_and_service_response(monkeypatch):
    db = database.SessionLocal()
    driver_id = "TASSTDRV1"
    username = "test_assistant_driver"
    password = "AssistPass101"
    awb = "TASSISTAWB101"
    captured = {}
    try:
        db.query(models.Shipment).filter(models.Shipment.awb == awb).delete()
        db.query(models.Driver).filter(models.Driver.driver_id == driver_id).delete()
        db.commit()

        db.add(
            models.Driver(
                driver_id=driver_id,
                name="Assistant Driver",
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
                recipient_name="Test Recipient",
                recipient_phone="+40740000001",
                delivery_address="Bacau, Str Test 1",
                locality="Bacau",
                cod_amount=129.5,
                driver_id=driver_id,
            )
        )
        db.commit()

        async def fake_answer_question(*, question, role, context):
            captured["question"] = question
            captured["role"] = role
            captured["context"] = context
            return {
                "answer": "Raspuns test asistent",
                "suggestions": ["Vezi AWB", "Verifica ruta"],
                "provider": "test_provider",
                "model": "test-model",
            }

        monkeypatch.setattr(main_module.assistant_service, "answer_question", fake_answer_question)

        login = client.post("/login", data={"username": username, "password": password})
        assert login.status_code == 200, login.text
        token = login.json().get("access_token")
        assert token

        res = client.post(
            "/assistant/ask",
            json={
                "question": f"Care este statusul pentru {awb}?",
                "context": {"screen": "assistant"},
            },
            headers={"Authorization": f"Bearer {token}"},
        )
        assert res.status_code == 200, res.text
        body = res.json()
        assert body.get("answer") == "Raspuns test asistent"
        assert body.get("provider") == "test_provider"
        assert body.get("model") == "test-model"
        assert awb in (body.get("context_awbs") or [])

        assert captured.get("role") == "Driver"
        ctx = captured.get("context") or {}
        assert (ctx.get("user") or {}).get("driver_id") == driver_id
        assert (ctx.get("client_context") or {}).get("screen") == "assistant"
        ships = ctx.get("shipments") or []
        assert any(str(row.get("awb") or "").upper() == awb for row in ships)
    finally:
        db.query(models.Shipment).filter(models.Shipment.awb == awb).delete()
        db.query(models.Driver).filter(models.Driver.driver_id == driver_id).delete()
        db.commit()
        db.close()


def test_assistant_ask_allows_recipient_role(monkeypatch):
    db = database.SessionLocal()
    recipient_id = "TASSTRCP1"
    username = "test_assistant_recipient"
    password = "AssistPass102"
    captured = {}
    try:
        db.query(models.Driver).filter(models.Driver.driver_id == recipient_id).delete()
        db.commit()

        db.add(
            models.Driver(
                driver_id=recipient_id,
                name="Assistant Recipient",
                username=username,
                password_hash=driver_manager.get_password_hash(password),
                role="Recipient",
                active=True,
            )
        )
        db.commit()

        async def fake_answer_question(*, question, role, context):
            captured["question"] = question
            captured["role"] = role
            captured["context"] = context
            return {
                "answer": "Salut! Te pot ajuta cu livrarea.",
                "suggestions": ["Status AWB", "Reprogramare"],
                "provider": "test_provider",
                "model": None,
            }

        monkeypatch.setattr(main_module.assistant_service, "answer_question", fake_answer_question)

        login = client.post("/login", data={"username": username, "password": password})
        assert login.status_code == 200, login.text
        token = login.json().get("access_token")
        assert token

        res = client.post(
            "/assistant/ask",
            json={"question": "Cand primesc coletul meu?"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert res.status_code == 200, res.text
        body = res.json()
        assert "Salut" in str(body.get("answer") or "")
        assert body.get("provider") == "test_provider"
        assert captured.get("role") == "Recipient"
    finally:
        db.query(models.Driver).filter(models.Driver.driver_id == recipient_id).delete()
        db.commit()
        db.close()


def test_ndr_reasons_include_actions_and_flanco_destinations():
    db = database.SessionLocal()
    admin_password = "AdminNdr123"
    admin_id = "TNDRADM1"
    awbs = ("TNDRFLANCO1", "TNDRFLANCO2")
    try:
        db.query(models.Driver).filter(models.Driver.driver_id == admin_id).delete()
        for awb in awbs:
            db.query(models.Shipment).filter(models.Shipment.awb == awb).delete()
        db.commit()

        db.add(
            models.Driver(
                driver_id=admin_id,
                name="NDR Admin",
                username="test_admin_ndr",
                password_hash=driver_manager.get_password_hash(admin_password),
                role="Admin",
                active=True,
            )
        )
        db.add_all([
            models.Shipment(
                awb="TNDRFLANCO1",
                status="In Transit",
                recipient_name="Test Recipient 1",
                delivery_address="Str Test 1",
                locality="Iasi",
                weight=1.0,
                sender_shop_name="flanco iasi kaufland nicolina",
                sender_location={
                    "locationId": "FLN-IASI-1",
                    "name": "Flanco Iasi Kaufland Nicolina",
                    "locality": "Iasi",
                    "county": "Iasi",
                    "addressText": "Sos. Nicolina 57, Iasi",
                    "phoneNumber": "+40374477100",
                },
            ),
            models.Shipment(
                awb="TNDRFLANCO2",
                status="In Transit",
                recipient_name="Test Recipient 2",
                delivery_address="Str Test 2",
                locality="Bacau",
                weight=1.2,
                sender_shop_name="flanco smart discounter bacau supernova",
                sender_location={
                    "locationId": "FLN-BC-1",
                    "name": "Flanco Smart Discounter Bacau Supernova",
                    "locality": "Bacau",
                    "county": "Bacau",
                    "addressText": "Calea Republicii 181, Bacau",
                    "phoneNumber": "+40374477100",
                },
            ),
        ])
        db.commit()

        login = client.post(
            "/login",
            data={"username": "test_admin_ndr", "password": admin_password},
        )
        assert login.status_code == 200, login.text
        token = login.json().get("access_token")
        assert token

        response = client.get("/ndr/reasons", headers={"Authorization": f"Bearer {token}"})
        assert response.status_code == 200, response.text
        body = response.json()

        actions = body.get("actions") or []
        assert any(str(a.get("code")) == "REDIRECT_TO_FLANCO" for a in actions)

        destinations = body.get("flanco_destinations") or []
        assert destinations
        names = [str(d.get("name") or "").lower() for d in destinations]
        assert any("flanco" in name for name in names)
    finally:
        for awb in awbs:
            db.query(models.Shipment).filter(models.Shipment.awb == awb).delete()
        db.query(models.Driver).filter(models.Driver.driver_id == admin_id).delete()
        db.commit()
        db.close()


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

        async def fake_google_optimize_route(*, origin, stops, return_to_origin=True, api_key=None):
            _ = origin, stops, return_to_origin, api_key
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


def test_assign_route_plan_notifies_driver_helper_and_customers():
    db = database.SessionLocal()
    admin_id = "TRASGN01"
    admin_user = "test_assign_admin"
    admin_pass = "AssignPass01"
    driver_id = "TRASGND1"
    helper_id = "TRASGNH1"
    recipient_id = "TRASGNR1"
    awb_with_account = "TRASSIGNAWB01"
    awb_no_account = "TRASSIGNAWB02"
    route_date = "2026-03-12"
    route_name = "Bacau 1"
    try:
        main_module.route_planning_service.ensure_route_plans_schema(db)
        main_module.notifications_service.ensure_notifications_schema(db)
        main_module.contacts_service.ensure_contacts_schema(db)

        for did in (admin_id, driver_id, helper_id, recipient_id):
            db.query(models.Driver).filter(models.Driver.driver_id == did).delete()
        db.query(models.TrackingRequest).filter(
            models.TrackingRequest.awb.in_([awb_with_account, awb_no_account])
        ).delete(synchronize_session=False)
        db.query(models.ContactAttempt).filter(
            models.ContactAttempt.awb.in_([awb_with_account, awb_no_account])
        ).delete(synchronize_session=False)
        db.query(models.Notification).filter(
            models.Notification.awb.in_([awb_with_account, awb_no_account])
        ).delete(synchronize_session=False)
        db.query(models.RoutePlan).filter(
            models.RoutePlan.plan_date == route_date,
            models.RoutePlan.name == route_name,
        ).delete(synchronize_session=False)
        db.query(models.Shipment).filter(models.Shipment.awb.in_([awb_with_account, awb_no_account])).delete()
        db.commit()

        db.add_all([
            models.Driver(
                driver_id=admin_id,
                name="Assign Admin",
                username=admin_user,
                password_hash=driver_manager.get_password_hash(admin_pass),
                role="Admin",
                active=True,
            ),
            models.Driver(
                driver_id=driver_id,
                name="Assigned Driver",
                username="assign_driver",
                password_hash=driver_manager.get_password_hash("x"),
                role="Driver",
                active=True,
                truck_plate="B001AAA",
            ),
            models.Driver(
                driver_id=helper_id,
                name="Helper User",
                username="assign_helper",
                password_hash=driver_manager.get_password_hash("x"),
                role="Warehouse",
                active=True,
            ),
            models.Driver(
                driver_id=recipient_id,
                name="Recipient Account",
                username="recipient_assign",
                password_hash=driver_manager.get_password_hash("x"),
                role="Recipient",
                active=True,
                phone_number="+40740000111",
                phone_norm="40740000111",
            ),
        ])
        db.add_all([
            models.Shipment(
                awb=awb_with_account,
                status="Out for delivery",
                recipient_name="Account Recipient",
                recipient_phone="+40740000111",
                recipient_phone_norm="40740000111",
                delivery_address="Bacau",
                locality="Bacau",
                cod_amount=55.5,
                number_of_parcels=1,
                delivery_instructions="Standard",
            ),
            models.Shipment(
                awb=awb_no_account,
                status="Out for delivery",
                recipient_name="No Account Recipient",
                recipient_phone="+40740000999",
                recipient_phone_norm="40740000999",
                recipient_email="external@example.com",
                delivery_address="Bacau",
                locality="Bacau",
                cod_amount=20.0,
                number_of_parcels=2,
                delivery_instructions="Retur deseu la GreenWee Buzau",
            ),
            models.RoutePlan(
                plan_date=route_date,
                county="Bacau",
                route_index=1,
                name=route_name,
                status="Approved",
                awbs=[awb_with_account, awb_no_account],
                awb_count=2,
                created_at=datetime.utcnow(),
                updated_at=datetime.utcnow(),
            ),
        ])
        db.commit()

        plan = (
            db.query(models.RoutePlan)
            .filter(models.RoutePlan.plan_date == route_date, models.RoutePlan.name == route_name)
            .first()
        )
        assert plan is not None

        login = client.post("/login", data={"username": admin_user, "password": admin_pass})
        assert login.status_code == 200, login.text
        token = login.json().get("access_token")
        assert token

        res = client.post(
            f"/routes/plans/{int(plan.id)}/assign",
            json={"driver_id": driver_id, "helper_name": "Helper User", "vehicle_plate": "B001AAA"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert res.status_code == 200, res.text
        body = res.json()
        assert int(body.get("allocated_awbs") or 0) == 2

        driver_notifs = db.query(models.Notification).filter(models.Notification.user_id == driver_id).all()
        helper_notifs = db.query(models.Notification).filter(models.Notification.user_id == helper_id).all()
        recipient_notifs = db.query(models.Notification).filter(models.Notification.user_id == recipient_id).all()

        assert any((n.data or {}).get("type") == "route_assignment" for n in driver_notifs)
        assert any((n.data or {}).get("type") == "route_assignment_helper" for n in helper_notifs)
        assert any((n.data or {}).get("type") == "route_awb_assigned" and n.awb == awb_with_account for n in recipient_notifs)

        external_attempts = (
            db.query(models.ContactAttempt)
            .filter(models.ContactAttempt.awb == awb_no_account)
            .all()
        )
        channels = {str(a.channel or "").strip().lower() for a in external_attempts}
        assert "whatsapp" in channels
    finally:
        for did in (admin_id, driver_id, helper_id, recipient_id):
            db.query(models.Driver).filter(models.Driver.driver_id == did).delete()
        db.query(models.ContactAttempt).filter(
            models.ContactAttempt.awb.in_([awb_with_account, awb_no_account])
        ).delete(synchronize_session=False)
        db.query(models.Notification).filter(
            models.Notification.awb.in_([awb_with_account, awb_no_account])
        ).delete(synchronize_session=False)
        db.query(models.RoutePlan).filter(
            models.RoutePlan.plan_date == route_date,
            models.RoutePlan.name == route_name,
        ).delete(synchronize_session=False)
        db.query(models.Shipment).filter(models.Shipment.awb.in_([awb_with_account, awb_no_account])).delete()
        db.commit()
        db.close()


def test_recipient_tracking_requires_driver_departure_mark():
    db = database.SessionLocal()
    admin_id = "TRTRKADM1"
    admin_user = "track_gate_admin"
    admin_pass = "TrackGatePass1"
    driver_id = "TRTRKDRV1"
    recipient_id = "TRTRKREC1"
    awb = "TRTRKAWB01"
    run_id = None
    try:
        main_module.route_runs_service.ensure_route_runs_schema(db)
        main_module.tracking_service.ensure_tracking_schema(db)

        for did in (admin_id, driver_id, recipient_id):
            db.query(models.Driver).filter(models.Driver.driver_id == did).delete()
        db.query(models.TrackingRequest).filter(models.TrackingRequest.awb == awb).delete(synchronize_session=False)
        db.query(models.RouteRunStop).filter(models.RouteRunStop.awb == awb).delete(synchronize_session=False)
        db.query(models.RouteRun).filter(models.RouteRun.route_id == "TRTRK-ROUTE").delete(synchronize_session=False)
        db.query(models.Shipment).filter(models.Shipment.awb == awb).delete()
        db.commit()

        db.add_all([
            models.Driver(
                driver_id=admin_id,
                name="Track Admin",
                username=admin_user,
                password_hash=driver_manager.get_password_hash(admin_pass),
                role="Admin",
                active=True,
            ),
            models.Driver(
                driver_id=driver_id,
                name="Track Driver",
                username="track_driver_gate",
                password_hash=driver_manager.get_password_hash("DriverPass1"),
                role="Driver",
                active=True,
            ),
            models.Driver(
                driver_id=recipient_id,
                name="Track Recipient",
                username="track_recipient_gate",
                password_hash=driver_manager.get_password_hash("RecipientPass1"),
                role="Recipient",
                active=True,
                phone_number="+40740000222",
                phone_norm="40740000222",
            ),
            models.Shipment(
                awb=awb,
                status="Out for delivery",
                recipient_name="Track Recipient",
                recipient_phone="+40740000222",
                recipient_phone_norm="40740000222",
                delivery_address="Iasi",
                locality="Iasi",
                driver_id=driver_id,
            ),
        ])
        db.commit()

        run = main_module.route_runs_service.start_run(
            db,
            route_id="TRTRK-ROUTE",
            route_name="Tracking Route",
            awbs=[awb],
            driver_id=driver_id,
            truck_plate=None,
            helper_name=None,
            created_by_role="driver",
            data=None,
        )
        assert run is not None
        db.commit()
        db.refresh(run)
        run_id = int(run.id)

        rec_login = client.post("/login", data={"username": "track_recipient_gate", "password": "RecipientPass1"})
        assert rec_login.status_code == 200, rec_login.text
        rec_token = rec_login.json().get("access_token")
        assert rec_token

        denied = client.post(
            "/tracking/requests",
            json={"awb": awb, "duration_sec": 900},
            headers={"Authorization": f"Bearer {rec_token}"},
        )
        assert denied.status_code == 409, denied.text

        driver_login = client.post("/login", data={"username": "track_driver_gate", "password": "DriverPass1"})
        assert driver_login.status_code == 200, driver_login.text
        driver_token = driver_login.json().get("access_token")
        assert driver_token

        depart = client.post(
            f"/route-runs/{run_id}/stops/{awb}/depart",
            json={"latitude": 46.56, "longitude": 26.91},
            headers={"Authorization": f"Bearer {driver_token}"},
        )
        assert depart.status_code == 200, depart.text
        assert str(depart.json().get("state")) == "OnTheWay"

        allowed = client.post(
            "/tracking/requests",
            json={"awb": awb, "duration_sec": 900},
            headers={"Authorization": f"Bearer {rec_token}"},
        )
        assert allowed.status_code == 201, allowed.text
        assert str(allowed.json().get("status")) == "Accepted"
    finally:
        if run_id is not None:
            db.query(models.RouteRunStop).filter(models.RouteRunStop.run_id == run_id).delete(synchronize_session=False)
            db.query(models.RouteRun).filter(models.RouteRun.id == run_id).delete(synchronize_session=False)
        for did in (admin_id, driver_id, recipient_id):
            db.query(models.Driver).filter(models.Driver.driver_id == did).delete()
        db.query(models.TrackingRequest).filter(models.TrackingRequest.awb == awb).delete(synchronize_session=False)
        db.query(models.Shipment).filter(models.Shipment.awb == awb).delete()
        db.commit()
        db.close()


def test_reschedule_request_accepts_period_and_3h_slot():
    db = database.SessionLocal()
    recipient_id = "TRRSLREC1"
    driver_id = "TRRSLDRV1"
    awb = "TRRSLAWB01"
    recipient_user = "resched_recipient_1"
    recipient_pass = "ReschedPass1"
    try:
        main_module.notifications_service.ensure_notifications_schema(db)

        for did in (recipient_id, driver_id):
            db.query(models.Driver).filter(models.Driver.driver_id == did).delete()
        db.query(models.Notification).filter(models.Notification.awb == awb).delete(synchronize_session=False)
        db.query(models.Shipment).filter(models.Shipment.awb == awb).delete()
        db.commit()

        db.add_all([
            models.Driver(
                driver_id=recipient_id,
                name="Resched Recipient",
                username=recipient_user,
                password_hash=driver_manager.get_password_hash(recipient_pass),
                role="Recipient",
                active=True,
                phone_number="+40740000333",
                phone_norm="40740000333",
            ),
            models.Driver(
                driver_id=driver_id,
                name="Resched Driver",
                username="resched_driver_1",
                password_hash=driver_manager.get_password_hash("x"),
                role="Driver",
                active=True,
            ),
            models.Shipment(
                awb=awb,
                status="Out for delivery",
                recipient_name="Resched Recipient",
                recipient_phone="+40740000333",
                recipient_phone_norm="40740000333",
                delivery_address="Roman",
                locality="Roman",
                driver_id=driver_id,
            ),
        ])
        db.commit()

        login = client.post("/login", data={"username": recipient_user, "password": recipient_pass})
        assert login.status_code == 200, login.text
        token = login.json().get("access_token")
        assert token

        res = client.post(
            f"/shipments/{awb}/reschedule-request",
            json={
                "desired_date": "2026-03-20",
                "period": "morning",
                "slot_code": "morning_09_12",
                "reason_code": "RECIPIENT_NOT_HOME",
                "note": "Plecat de acasa pana la pranz.",
            },
            headers={"Authorization": f"Bearer {token}"},
        )
        assert res.status_code == 200, res.text
        body = res.json()
        assert body.get("period") == "morning"
        assert body.get("slot_code") == "morning_09_12"
        assert "09:00-12:00" in str(body.get("requested_window_label") or "")

        driver_notifs = (
            db.query(models.Notification)
            .filter(models.Notification.user_id == driver_id, models.Notification.awb == awb)
            .all()
        )
        assert any((n.data or {}).get("slot_code") == "morning_09_12" for n in driver_notifs)
    finally:
        for did in (recipient_id, driver_id):
            db.query(models.Driver).filter(models.Driver.driver_id == did).delete()
        db.query(models.Notification).filter(models.Notification.awb == awb).delete(synchronize_session=False)
        db.query(models.Shipment).filter(models.Shipment.awb == awb).delete()
        db.commit()
        db.close()


def test_admin_can_create_manual_awb_and_get_arynik_label_pdf():
    db = database.SessionLocal()
    admin_id = "TMANADM1"
    admin_user = "test_manual_admin"
    admin_pass = "ManualPass1"
    awb = "TMANUALAWB001"
    try:
        db.query(models.Shipment).filter(models.Shipment.awb == awb).delete()
        db.query(models.Driver).filter(models.Driver.driver_id == admin_id).delete()
        db.commit()

        db.add(
            models.Driver(
                driver_id=admin_id,
                name="Manual Admin",
                username=admin_user,
                password_hash=driver_manager.get_password_hash(admin_pass),
                role="Admin",
                active=True,
            )
        )
        db.commit()

        login = client.post("/login", data={"username": admin_user, "password": admin_pass})
        assert login.status_code == 200, login.text
        token = login.json().get("access_token")
        assert token

        create = client.post(
            "/shipments/manual",
            json={
                "awb": awb,
                "recipient_name": "Manual Recipient",
                "recipient_phone": "+40740000555",
                "delivery_address": "Str. Independentei 10",
                "locality": "Bacau",
                "county": "Bacau",
                "cod_amount": 120.5,
                "weight": 7.4,
                "number_of_parcels": 2,
                "content_description": "Masina de spalat",
            },
            headers={"Authorization": f"Bearer {token}"},
        )
        assert create.status_code == 200, create.text
        body = create.json()
        assert body.get("awb") == awb
        assert body.get("local_shipment") is True
        assert body.get("local_awb_shipment") is True
        assert body.get("shipment_label_available") is True
        assert str(body.get("source_channel") or "") == "ARYNIK_LOCAL"

        label = client.get(
            f"/shipments/{awb}/label",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert label.status_code == 200, label.text
        assert "application/pdf" in str(label.headers.get("content-type") or "")
        assert label.content.startswith(b"%PDF")
        assert b"ARYNIK" in label.content
    finally:
        db.query(models.ShipmentEvent).filter(
            models.ShipmentEvent.shipment_id.in_(
                db.query(models.Shipment.id).filter(models.Shipment.awb == awb)
            )
        ).delete(synchronize_session=False)
        db.query(models.Shipment).filter(models.Shipment.awb == awb).delete()
        db.query(models.Driver).filter(models.Driver.driver_id == admin_id).delete()
        db.commit()
        db.close()


def test_admin_can_recommend_carrier_and_persist_selection_on_manual_awb():
    db = database.SessionLocal()
    admin_id = "TCARRADM1"
    admin_user = "test_carrier_admin"
    admin_pass = "CarrierPass1"
    awb = "TCARRIERAWB001"
    wh_id = None
    st_id = None
    try:
        db.query(models.Shipment).filter(models.Shipment.awb == awb).delete(synchronize_session=False)
        db.query(models.Driver).filter(models.Driver.driver_id == admin_id).delete(synchronize_session=False)
        db.commit()

        wh = models.Warehouse(
            code="WH-CARR-1",
            name="Carrier Warehouse",
            address="Bacau",
            latitude=46.5667,
            longitude=26.9167,
            active=True,
        )
        db.add(wh)
        db.flush()
        wh_id = int(wh.id)

        st = models.Store(
            code="ST-CARR-1",
            name="Carrier Store",
            warehouse_id=wh_id,
            address="Bacau",
            latitude=46.57,
            longitude=26.92,
            active=True,
        )
        db.add(st)
        db.flush()
        st_id = int(st.id)

        db.add(
            models.Driver(
                driver_id=admin_id,
                name="Carrier Admin",
                username=admin_user,
                password_hash=driver_manager.get_password_hash(admin_pass),
                role="Admin",
                active=True,
            )
        )
        db.commit()

        login = client.post("/login", data={"username": admin_user, "password": admin_pass})
        assert login.status_code == 200, login.text
        token = login.json().get("access_token")
        assert token

        carriers = client.get("/carriers", headers={"Authorization": f"Bearer {token}"})
        assert carriers.status_code == 200, carriers.text
        carrier_rows = carriers.json() or []
        assert isinstance(carrier_rows, list) and len(carrier_rows) >= 1

        rec = client.post(
            "/carriers/recommendation",
            json={
                "warehouse_id": wh_id,
                "store_id": st_id,
                "locality": "Bacau",
                "delivery_address": "Str. Mioritei 12",
                "weight": 8.0,
                "cod_amount": 120.0,
                "priority": "cost",
            },
            headers={"Authorization": f"Bearer {token}"},
        )
        assert rec.status_code == 200, rec.text
        rec_body = rec.json()
        options = rec_body.get("options") or []
        assert isinstance(options, list) and len(options) >= 1
        selected_code = str(rec_body.get("recommended_code") or options[0].get("code") or "").strip().upper()
        assert selected_code

        created = client.post(
            "/shipments/manual",
            json={
                "awb": awb,
                "recipient_name": "Carrier Recipient",
                "recipient_phone": "+40745555111",
                "delivery_address": "Bacau, Str. Mioritei 12",
                "locality": "Bacau",
                "warehouse_id": wh_id,
                "store_id": st_id,
                "cod_amount": 120.0,
                "weight": 8.0,
                "carrier_code": selected_code,
                "carrier_priority": "cost",
            },
            headers={"Authorization": f"Bearer {token}"},
        )
        assert created.status_code == 200, created.text
        body = created.json()
        assert body.get("awb") == awb
        assert float(body.get("shipping_cost") or 0.0) > 0.0
        raw_data = body.get("raw_data") or {}
        courier = raw_data.get("courier") or {}
        assert str(courier.get("carrierId") or "").strip().upper() == selected_code
    finally:
        db.query(models.ShipmentEvent).filter(
            models.ShipmentEvent.shipment_id.in_(
                db.query(models.Shipment.id).filter(models.Shipment.awb == awb)
            )
        ).delete(synchronize_session=False)
        db.query(models.Shipment).filter(models.Shipment.awb == awb).delete(synchronize_session=False)
        db.query(models.Driver).filter(models.Driver.driver_id == admin_id).delete(synchronize_session=False)
        if st_id is not None:
            db.query(models.Store).filter(models.Store.id == st_id).delete(synchronize_session=False)
        if wh_id is not None:
            db.query(models.Warehouse).filter(models.Warehouse.id == wh_id).delete(synchronize_session=False)
        db.commit()
        db.close()


def test_non_admin_cannot_create_manual_awb():
    db = database.SessionLocal()
    dispatcher_id = "TMANDSP1"
    dispatcher_user = "test_manual_dispatcher"
    dispatcher_pass = "ManualPass2"
    awb = "TMANUALAWB002"
    try:
        db.query(models.Shipment).filter(models.Shipment.awb == awb).delete()
        db.query(models.Driver).filter(models.Driver.driver_id == dispatcher_id).delete()
        db.commit()

        db.add(
            models.Driver(
                driver_id=dispatcher_id,
                name="Manual Dispatcher",
                username=dispatcher_user,
                password_hash=driver_manager.get_password_hash(dispatcher_pass),
                role="Dispatcher",
                active=True,
            )
        )
        db.commit()

        login = client.post("/login", data={"username": dispatcher_user, "password": dispatcher_pass})
        assert login.status_code == 200, login.text
        token = login.json().get("access_token")
        assert token

        create = client.post(
            "/shipments/manual",
            json={
                "awb": awb,
                "recipient_name": "Denied Recipient",
                "delivery_address": "Bacau",
                "locality": "Bacau",
            },
            headers={"Authorization": f"Bearer {token}"},
        )
        assert create.status_code == 403, create.text
    finally:
        db.query(models.Shipment).filter(models.Shipment.awb == awb).delete()
        db.query(models.Driver).filter(models.Driver.driver_id == dispatcher_id).delete()
        db.commit()
        db.close()


def test_admin_can_seed_flanco_store_accounts():
    db = database.SessionLocal()
    admin_id = "TFLNADM1"
    admin_user = "test_flanco_seed_admin"
    admin_pass = "FlancoPass1"
    expected = {
        "flanco.bacau.supernova": "FLN-BC-SUPERNOVA",
        "flanco.iasi.nicolina": "FLN-IS-KA-NICOLINA",
        "flanco.suceava.carrefour": "FLN-SV-CARREFOUR",
    }
    try:
        db.query(models.Driver).filter(models.Driver.driver_id == admin_id).delete()
        db.commit()
        db.add(
            models.Driver(
                driver_id=admin_id,
                name="Flanco Seed Admin",
                username=admin_user,
                password_hash=driver_manager.get_password_hash(admin_pass),
                role="Admin",
                active=True,
            )
        )
        db.commit()

        login = client.post("/login", data={"username": admin_user, "password": admin_pass})
        assert login.status_code == 200, login.text
        token = login.json().get("access_token")
        assert token

        seeded = client.post(
            "/users/seed-flanco-store-accounts",
            params={"reset_passwords": 1},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert seeded.status_code == 200, seeded.text
        rows = seeded.json() or []
        assert isinstance(rows, list)
        assert len(rows) >= 3

        stores = db.query(models.Store).all()
        stores_by_code = {
            str(getattr(s, "code", "") or "").strip().upper(): s
            for s in stores
            if str(getattr(s, "code", "") or "").strip()
        }
        users = db.query(models.Driver).all()
        users_by_username = {
            str(getattr(u, "username", "") or "").strip().lower(): u
            for u in users
            if str(getattr(u, "username", "") or "").strip()
        }

        for username, store_code in expected.items():
            store = stores_by_code.get(store_code)
            assert store is not None
            user = users_by_username.get(username)
            assert user is not None
            assert str(user.role or "") == "Store"
            assert int(user.store_id or 0) == int(store.id or 0)
            assert int(user.warehouse_id or 0) == int(store.warehouse_id or 0)
    finally:
        db.query(models.Driver).filter(models.Driver.driver_id == admin_id).delete()
        db.commit()
        db.close()


def test_admin_can_import_manifest_awbs_from_csv_file():
    db = database.SessionLocal()
    admin_id = "TMIFADM1"
    admin_user = "test_manifest_import_admin"
    admin_pass = "ImportPass1"
    manifest_id = None
    try:
        db.query(models.Driver).filter(models.Driver.driver_id == admin_id).delete()
        db.commit()

        db.add(
            models.Driver(
                driver_id=admin_id,
                name="Manifest Import Admin",
                username=admin_user,
                password_hash=driver_manager.get_password_hash(admin_pass),
                role="Admin",
                active=True,
            )
        )
        db.commit()

        login = client.post("/login", data={"username": admin_user, "password": admin_pass})
        assert login.status_code == 200, login.text
        token = login.json().get("access_token")
        assert token

        created = client.post(
            "/manifests",
            json={
                "truck_plate": "B101MIF",
                "kind": "unload",
                "date": "2026-03-12",
            },
            headers={"Authorization": f"Bearer {token}"},
        )
        assert created.status_code == 201, created.text
        manifest_id = int(created.json().get("id"))

        csv_bytes = b"awb\nROAWB00001\nROAWB00001\nROAWB00002001\n"
        imported = client.post(
            f"/manifests/{manifest_id}/import-awbs",
            headers={"Authorization": f"Bearer {token}"},
            files={"file": ("manifest.csv", csv_bytes, "text/csv")},
        )
        assert imported.status_code == 200, imported.text
        body = imported.json()
        assert int(body.get("imported_count") or 0) == 2
        assert int(body.get("duplicate_count") or 0) == 1
        assert int(body.get("invalid_count") or 0) == 0

        opened = client.get(
            f"/manifests/{manifest_id}",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert opened.status_code == 200, opened.text
        manifest = opened.json()
        awbs = {str(item.get("awb")) for item in (manifest.get("items") or [])}
        assert "ROAWB00001" in awbs
        assert "ROAWB00002" in awbs
    finally:
        if manifest_id is not None:
            db.query(models.ManifestItem).filter(models.ManifestItem.manifest_id == manifest_id).delete(synchronize_session=False)
            db.query(models.Manifest).filter(models.Manifest.id == manifest_id).delete(synchronize_session=False)
        db.query(models.Driver).filter(models.Driver.driver_id == admin_id).delete()
        db.commit()
        db.close()


def test_non_admin_cannot_import_manifest_awbs():
    db = database.SessionLocal()
    driver_id = "TMIFDRV1"
    driver_user = "test_manifest_import_driver"
    driver_pass = "ImportPass2"
    manifest_id = None
    try:
        db.query(models.Driver).filter(models.Driver.driver_id == driver_id).delete()
        db.commit()

        db.add(
            models.Driver(
                driver_id=driver_id,
                name="Manifest Import Driver",
                username=driver_user,
                password_hash=driver_manager.get_password_hash(driver_pass),
                role="Driver",
                active=True,
            )
        )
        db.commit()

        login = client.post("/login", data={"username": driver_user, "password": driver_pass})
        assert login.status_code == 200, login.text
        token = login.json().get("access_token")
        assert token

        created = client.post(
            "/manifests",
            json={
                "truck_plate": "B102MIF",
                "kind": "unload",
                "date": "2026-03-12",
            },
            headers={"Authorization": f"Bearer {token}"},
        )
        assert created.status_code == 201, created.text
        manifest_id = int(created.json().get("id"))

        denied = client.post(
            f"/manifests/{manifest_id}/import-awbs",
            headers={"Authorization": f"Bearer {token}"},
            files={"file": ("manifest.csv", b"awb\nROAWB90001\n", "text/csv")},
        )
        assert denied.status_code == 403, denied.text
    finally:
        if manifest_id is not None:
            db.query(models.ManifestItem).filter(models.ManifestItem.manifest_id == manifest_id).delete(synchronize_session=False)
            db.query(models.Manifest).filter(models.Manifest.id == manifest_id).delete(synchronize_session=False)
        db.query(models.Driver).filter(models.Driver.driver_id == driver_id).delete()
        db.commit()
        db.close()


def test_store_scope_and_manual_awb_and_return_confirm():
    db = database.SessionLocal()
    store_user_id = "TSTORE001"
    store_username = "store_scope_user"
    store_pass = "StorePass001"
    wh_id = None
    st_id = None
    created_awb = "STMANUAL001"
    try:
        db.query(models.Shipment).filter(models.Shipment.awb.in_(("STORESCOPE1", "STORESCOPE2", created_awb))).delete(synchronize_session=False)
        db.query(models.Driver).filter(models.Driver.driver_id == store_user_id).delete(synchronize_session=False)
        db.commit()

        wh = models.Warehouse(code="WH-ST-1", name="Warehouse Store Scope", active=True)
        db.add(wh)
        db.flush()
        wh_id = int(wh.id)

        st = models.Store(code="FLN-BACAU-01", name="Flanco Bacau", warehouse_id=wh_id, active=True)
        db.add(st)
        db.flush()
        st_id = int(st.id)

        db.add(
            models.Driver(
                driver_id=store_user_id,
                name="Store User",
                username=store_username,
                password_hash=driver_manager.get_password_hash(store_pass),
                role="Store",
                active=True,
                warehouse_id=wh_id,
                store_id=st_id,
            )
        )
        db.add_all([
            models.Shipment(
                awb="STORESCOPE1",
                status="In Transit",
                recipient_name="Client A",
                delivery_address="Bacau",
                locality="Bacau",
                sender_shop_name="Flanco Bacau",
                store_id=st_id,
                warehouse_id=wh_id,
            ),
            models.Shipment(
                awb="STORESCOPE2",
                status="In Transit",
                recipient_name="Client B",
                delivery_address="Iasi",
                locality="Iasi",
                sender_shop_name="Other Store",
            ),
        ])
        db.commit()

        login = client.post("/login", data={"username": store_username, "password": store_pass})
        assert login.status_code == 200, login.text
        token = login.json().get("access_token")
        assert token

        scoped = client.get("/shipments", headers={"Authorization": f"Bearer {token}"})
        assert scoped.status_code == 200, scoped.text
        awbs = {str(row.get("awb") or "").upper() for row in (scoped.json() or [])}
        assert "STORESCOPE1" in awbs
        assert "STORESCOPE2" not in awbs

        created = client.post(
            "/shipments/manual",
            json={
                "awb": created_awb,
                "recipient_name": "Manual Store Recipient",
                "delivery_address": "Bacau, Str. Test 11",
                "locality": "Bacau",
                "store_id": st_id,
                "warehouse_id": wh_id,
                "cod_amount": 10.0,
            },
            headers={"Authorization": f"Bearer {token}"},
        )
        assert created.status_code == 200, created.text
        body = created.json()
        assert int(body.get("store_id") or 0) == st_id
        assert int(body.get("warehouse_id") or 0) == wh_id

        confirmed = client.post(
            f"/shipments/{created_awb}/confirm-return",
            json={"notes": "Returned and received in store"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert confirmed.status_code == 200, confirmed.text
        conf_body = confirmed.json()
        assert str(conf_body.get("return_confirmed_by") or "") == store_user_id
        assert conf_body.get("return_confirmed_at")
    finally:
        db.query(models.Shipment).filter(models.Shipment.awb.in_(("STORESCOPE1", "STORESCOPE2", created_awb))).delete(synchronize_session=False)
        db.query(models.Driver).filter(models.Driver.driver_id == store_user_id).delete(synchronize_session=False)
        if st_id is not None:
            db.query(models.Store).filter(models.Store.id == st_id).delete(synchronize_session=False)
        if wh_id is not None:
            db.query(models.Warehouse).filter(models.Warehouse.id == wh_id).delete(synchronize_session=False)
        db.commit()
        db.close()


def test_warehouse_scope_filters_shipments_by_warehouse():
    db = database.SessionLocal()
    user_id = "TWAREH001"
    username = "warehouse_scope_user"
    password = "WarehousePass001"
    wh1_id = None
    wh2_id = None
    st1_id = None
    st2_id = None
    awb_in = "WHSCOPEIN1"
    awb_out = "WHSCOPEOUT1"
    try:
        db.query(models.Shipment).filter(models.Shipment.awb.in_((awb_in, awb_out))).delete(synchronize_session=False)
        db.query(models.Driver).filter(models.Driver.driver_id == user_id).delete(synchronize_session=False)
        db.commit()

        wh1 = models.Warehouse(code="WH-SCP-1", name="Scope Warehouse 1", active=True)
        wh2 = models.Warehouse(code="WH-SCP-2", name="Scope Warehouse 2", active=True)
        db.add_all([wh1, wh2])
        db.flush()
        wh1_id = int(wh1.id)
        wh2_id = int(wh2.id)

        st1 = models.Store(code="ST-SCP-1", name="Scope Store 1", warehouse_id=wh1_id, active=True)
        st2 = models.Store(code="ST-SCP-2", name="Scope Store 2", warehouse_id=wh2_id, active=True)
        db.add_all([st1, st2])
        db.flush()
        st1_id = int(st1.id)
        st2_id = int(st2.id)

        db.add(
            models.Driver(
                driver_id=user_id,
                name="Warehouse Scope User",
                username=username,
                password_hash=driver_manager.get_password_hash(password),
                role="Warehouse",
                active=True,
                warehouse_id=wh1_id,
            )
        )
        db.add_all([
            models.Shipment(
                awb=awb_in,
                status="In Transit",
                recipient_name="W Client 1",
                delivery_address="Bacau",
                locality="Bacau",
                warehouse_id=wh1_id,
                store_id=st1_id,
            ),
            models.Shipment(
                awb=awb_out,
                status="In Transit",
                recipient_name="W Client 2",
                delivery_address="Iasi",
                locality="Iasi",
                warehouse_id=wh2_id,
                store_id=st2_id,
            ),
        ])
        db.commit()

        login = client.post("/login", data={"username": username, "password": password})
        assert login.status_code == 200, login.text
        token = login.json().get("access_token")
        assert token

        scoped = client.get("/shipments", headers={"Authorization": f"Bearer {token}"})
        assert scoped.status_code == 200, scoped.text
        awbs = {str(row.get("awb") or "").upper() for row in (scoped.json() or [])}
        assert awb_in in awbs
        assert awb_out not in awbs
    finally:
        db.query(models.Shipment).filter(models.Shipment.awb.in_((awb_in, awb_out))).delete(synchronize_session=False)
        db.query(models.Driver).filter(models.Driver.driver_id == user_id).delete(synchronize_session=False)
        if st1_id is not None:
            db.query(models.Store).filter(models.Store.id == st1_id).delete(synchronize_session=False)
        if st2_id is not None:
            db.query(models.Store).filter(models.Store.id == st2_id).delete(synchronize_session=False)
        if wh1_id is not None:
            db.query(models.Warehouse).filter(models.Warehouse.id == wh1_id).delete(synchronize_session=False)
        if wh2_id is not None:
            db.query(models.Warehouse).filter(models.Warehouse.id == wh2_id).delete(synchronize_session=False)
        db.commit()
        db.close()


def test_phone_assignment_controls_vehicle_km_allocation_across_days():
    db = database.SessionLocal()
    admin_id = "TFLEETADM1"
    driver_id = "TFLEETDRV1"
    admin_user = "fleet_assign_admin"
    driver_user = "fleet_assign_driver"
    password = "FleetPass1"
    plate_a = "B777FLE"
    plate_b = "B778FLE"
    phone_label = "phone-fleet-test-01"
    vehicle_a_id = None
    vehicle_b_id = None
    try:
        main_module.fleet_service.ensure_fleet_schema(db)
        db.query(models.DriverLocation).filter(models.DriverLocation.driver_id == driver_id).delete(synchronize_session=False)
        db.query(models.FleetVehicleAssignment).filter(models.FleetVehicleAssignment.driver_id == driver_id).delete(synchronize_session=False)
        db.query(models.FleetVehicle).filter(models.FleetVehicle.plate.in_((plate_a, plate_b))).delete(synchronize_session=False)
        db.query(models.Driver).filter(models.Driver.driver_id.in_((admin_id, driver_id))).delete(synchronize_session=False)
        db.commit()

        db.add_all([
            models.Driver(
                driver_id=admin_id,
                name="Fleet Admin",
                username=admin_user,
                password_hash=driver_manager.get_password_hash(password),
                role="Admin",
                active=True,
            ),
            models.Driver(
                driver_id=driver_id,
                name="Fleet Driver",
                username=driver_user,
                password_hash=driver_manager.get_password_hash(password),
                role="Driver",
                active=True,
            ),
        ])
        db.commit()

        admin_login = client.post("/login", data={"username": admin_user, "password": password})
        assert admin_login.status_code == 200, admin_login.text
        admin_token = admin_login.json().get("access_token")
        assert admin_token

        driver_login = client.post("/login", data={"username": driver_user, "password": password})
        assert driver_login.status_code == 200, driver_login.text
        driver_token = driver_login.json().get("access_token")
        assert driver_token

        v1 = client.post(
            "/fleet/vehicles",
            json={"plate": plate_a, "label": "Truck A", "vehicle_type_code": "VAN_35T"},
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert v1.status_code == 201, v1.text
        vehicle_a_id = int(v1.json().get("id"))

        v2 = client.post(
            "/fleet/vehicles",
            json={"plate": plate_b, "label": "Truck B", "vehicle_type_code": "VAN_35T"},
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert v2.status_code == 201, v2.text
        vehicle_b_id = int(v2.json().get("id"))

        # Day 1: phone is manually assigned to Truck A.
        assign_a = client.post(
            "/fleet/assignments",
            json={"driver_id": driver_id, "vehicle_id": vehicle_a_id, "phone_label": phone_label},
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert assign_a.status_code == 201, assign_a.text

        loc1 = client.post(
            "/update-location",
            json={"latitude": 44.4268, "longitude": 26.1025, "phone_label": phone_label, "vehicle_plate": plate_b},
            headers={"Authorization": f"Bearer {driver_token}"},
        )
        assert loc1.status_code == 200, loc1.text
        assert int(loc1.json().get("vehicle_id") or 0) == vehicle_a_id

        time.sleep(0.03)
        loc2 = client.post(
            "/update-location",
            json={"latitude": 44.4270, "longitude": 26.1028, "phone_label": phone_label, "vehicle_plate": plate_b},
            headers={"Authorization": f"Bearer {driver_token}"},
        )
        assert loc2.status_code == 200, loc2.text
        assert int(loc2.json().get("vehicle_id") or 0) == vehicle_a_id

        veh_a = db.query(models.FleetVehicle).filter(models.FleetVehicle.id == vehicle_a_id).first()
        veh_b = db.query(models.FleetVehicle).filter(models.FleetVehicle.id == vehicle_b_id).first()
        assert veh_a is not None and veh_b is not None
        km_a_day1 = float(veh_a.odometer_km or 0.0)
        km_b_day1 = float(veh_b.odometer_km or 0.0)
        assert km_a_day1 > 0.0
        assert km_b_day1 == 0.0

        # Day 2: same phone is manually reassigned to Truck B.
        assign_b = client.post(
            "/fleet/assignments",
            json={"driver_id": driver_id, "vehicle_id": vehicle_b_id, "phone_label": phone_label},
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert assign_b.status_code == 201, assign_b.text

        loc3 = client.post(
            "/update-location",
            json={"latitude": 44.4272, "longitude": 26.1029, "phone_label": phone_label, "vehicle_plate": plate_a},
            headers={"Authorization": f"Bearer {driver_token}"},
        )
        assert loc3.status_code == 200, loc3.text
        assert int(loc3.json().get("vehicle_id") or 0) == vehicle_b_id

        time.sleep(0.03)
        loc4 = client.post(
            "/update-location",
            json={"latitude": 44.4275, "longitude": 26.1032, "phone_label": phone_label, "vehicle_plate": plate_a},
            headers={"Authorization": f"Bearer {driver_token}"},
        )
        assert loc4.status_code == 200, loc4.text
        assert int(loc4.json().get("vehicle_id") or 0) == vehicle_b_id

        db.expire_all()
        veh_a2 = db.query(models.FleetVehicle).filter(models.FleetVehicle.id == vehicle_a_id).first()
        veh_b2 = db.query(models.FleetVehicle).filter(models.FleetVehicle.id == vehicle_b_id).first()
        assert veh_a2 is not None and veh_b2 is not None
        km_a_day2 = float(veh_a2.odometer_km or 0.0)
        km_b_day2 = float(veh_b2.odometer_km or 0.0)
        assert km_a_day2 == km_a_day1
        assert km_b_day2 > km_b_day1
    finally:
        db.query(models.DriverLocation).filter(models.DriverLocation.driver_id == driver_id).delete(synchronize_session=False)
        db.query(models.FleetVehicleAssignment).filter(models.FleetVehicleAssignment.driver_id == driver_id).delete(synchronize_session=False)
        db.query(models.FleetVehicle).filter(models.FleetVehicle.plate.in_((plate_a, plate_b))).delete(synchronize_session=False)
        db.query(models.Driver).filter(models.Driver.driver_id.in_((admin_id, driver_id))).delete(synchronize_session=False)
        db.commit()
        db.close()


def test_fleet_vehicle_patch_allows_non_capacity_updates_on_legacy_invalid_capacity():
    db = database.SessionLocal()
    admin_id = "TFLEETADM2"
    admin_user = "fleet_patch_admin"
    password = "FleetPatchPass1"
    plate = "B779FLE"
    vehicle_id = None
    try:
        main_module.fleet_service.ensure_fleet_schema(db)
        db.query(models.FleetVehicle).filter(models.FleetVehicle.plate == plate).delete(synchronize_session=False)
        db.query(models.Driver).filter(models.Driver.driver_id == admin_id).delete(synchronize_session=False)
        db.commit()

        db.add(
            models.Driver(
                driver_id=admin_id,
                name="Fleet Patch Admin",
                username=admin_user,
                password_hash=driver_manager.get_password_hash(password),
                role="Admin",
                active=True,
            )
        )
        db.commit()

        # Legacy inconsistent row: target volume > max volume.
        bad = models.FleetVehicle(
            plate=plate,
            label="Legacy Bad Capacity",
            active=True,
            vehicle_type_code="VAN_35T",
            max_volume_m3=10.0,
            target_volume_m3=12.0,
        )
        db.add(bad)
        db.commit()
        db.refresh(bad)
        vehicle_id = int(bad.id)

        login = client.post("/login", data={"username": admin_user, "password": password})
        assert login.status_code == 200, login.text
        token = login.json().get("access_token")
        assert token

        # Should allow patching unrelated fields even if legacy capacity values are inconsistent.
        res = client.patch(
            f"/fleet/vehicles/{vehicle_id}",
            json={"notes": "updated note"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert res.status_code == 200, res.text
        body = res.json()
        assert str(body.get("notes") or "") == "updated note"
    finally:
        if vehicle_id is not None:
            db.query(models.FleetVehicle).filter(models.FleetVehicle.id == vehicle_id).delete(synchronize_session=False)
        db.query(models.Driver).filter(models.Driver.driver_id == admin_id).delete(synchronize_session=False)
        db.commit()
        db.close()
