from __future__ import annotations

from datetime import datetime, timedelta
import math
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import or_
from sqlalchemy import text
from sqlalchemy.orm import Session

try:
    from .. import models, authz
except ImportError:  # pragma: no cover
    import models, authz  # type: ignore


def ensure_fleet_schema(db: Session) -> bool:
    """
    Create fleet tables if missing.
    """
    try:
        bind = db.get_bind()
    except Exception:
        return False

    try:
        models.FleetVehicle.__table__.create(bind=bind, checkfirst=True)
        models.FleetVehicleAssignment.__table__.create(bind=bind, checkfirst=True)
        models.FleetDocument.__table__.create(bind=bind, checkfirst=True)
        models.FleetServiceRecord.__table__.create(bind=bind, checkfirst=True)
        models.FleetInsurancePolicy.__table__.create(bind=bind, checkfirst=True)
        _ensure_fleet_columns(db)
        return True
    except Exception:
        return False


def _ensure_fleet_columns(db: Session) -> None:
    """
    Lightweight runtime migrations for fleet tables.

    Older deployments might have tables without newer columns, which can cause
    read queries to fail with "no such column". Keep this additive only.
    """
    try:
        dialect = db.bind.dialect.name  # type: ignore[union-attr]
    except Exception:
        dialect = ""

    table_specs = {
        "fleet_vehicles": [
            ("label", "TEXT", "TEXT"),
            ("active", "BOOLEAN", "INTEGER"),
            ("assigned_driver_id", "TEXT", "TEXT"),
            ("assigned_driver_name", "TEXT", "TEXT"),
            ("assigned_phone", "TEXT", "TEXT"),
            ("helper_name", "TEXT", "TEXT"),
            ("vehicle_type_code", "TEXT", "TEXT"),
            ("vehicle_has_lift", "BOOLEAN", "INTEGER"),
            ("max_volume_m3", "DOUBLE PRECISION", "REAL"),
            ("target_volume_m3", "DOUBLE PRECISION", "REAL"),
            ("max_weight_kg", "DOUBLE PRECISION", "REAL"),
            ("target_weight_kg", "DOUBLE PRECISION", "REAL"),
            ("odometer_km", "DOUBLE PRECISION", "REAL"),
            ("purchase_date", "TIMESTAMP", "TEXT"),
            ("notes", "TEXT", "TEXT"),
            ("admin_data", "JSONB", "JSON"),
            ("created_at", "TIMESTAMP", "TEXT"),
            ("updated_at", "TIMESTAMP", "TEXT"),
        ],
        "fleet_vehicle_assignments": [
            ("driver_id", "TEXT", "TEXT"),
            ("vehicle_id", "INTEGER", "INTEGER"),
            ("vehicle_plate", "TEXT", "TEXT"),
            ("phone_label", "TEXT", "TEXT"),
            ("active", "BOOLEAN", "INTEGER"),
            ("assigned_at", "TIMESTAMP", "TEXT"),
            ("unassigned_at", "TIMESTAMP", "TEXT"),
            ("assigned_by_user_id", "TEXT", "TEXT"),
            ("source", "TEXT", "TEXT"),
            ("notes", "TEXT", "TEXT"),
            ("last_latitude", "DOUBLE PRECISION", "REAL"),
            ("last_longitude", "DOUBLE PRECISION", "REAL"),
            ("last_location_at", "TIMESTAMP", "TEXT"),
            ("km_total", "DOUBLE PRECISION", "REAL"),
            ("created_at", "TIMESTAMP", "TEXT"),
            ("updated_at", "TIMESTAMP", "TEXT"),
        ],
        "fleet_documents": [
            ("category", "TEXT", "TEXT"),
            ("title", "TEXT", "TEXT"),
            ("issuer", "TEXT", "TEXT"),
            ("status", "TEXT", "TEXT"),
            ("issue_date", "TIMESTAMP", "TEXT"),
            ("expiry_date", "TIMESTAMP", "TEXT"),
            ("reminder_days_before", "INTEGER", "INTEGER"),
            ("remind_at", "TIMESTAMP", "TEXT"),
            ("last_reminder_at", "TIMESTAMP", "TEXT"),
            ("file_url", "TEXT", "TEXT"),
            ("notes", "TEXT", "TEXT"),
            ("data", "JSONB", "JSON"),
            ("created_at", "TIMESTAMP", "TEXT"),
            ("updated_at", "TIMESTAMP", "TEXT"),
        ],
        "fleet_services": [
            ("service_type", "TEXT", "TEXT"),
            ("title", "TEXT", "TEXT"),
            ("provider", "TEXT", "TEXT"),
            ("status", "TEXT", "TEXT"),
            ("performed_at", "TIMESTAMP", "TEXT"),
            ("due_date", "TIMESTAMP", "TEXT"),
            ("odometer_km", "DOUBLE PRECISION", "REAL"),
            ("due_km", "DOUBLE PRECISION", "REAL"),
            ("next_due_km", "DOUBLE PRECISION", "REAL"),
            ("estimated_cost", "DOUBLE PRECISION", "REAL"),
            ("actual_cost", "DOUBLE PRECISION", "REAL"),
            ("currency", "TEXT", "TEXT"),
            ("reminder_days_before", "INTEGER", "INTEGER"),
            ("remind_at", "TIMESTAMP", "TEXT"),
            ("last_reminder_at", "TIMESTAMP", "TEXT"),
            ("notes", "TEXT", "TEXT"),
            ("data", "JSONB", "JSON"),
            ("created_at", "TIMESTAMP", "TEXT"),
            ("updated_at", "TIMESTAMP", "TEXT"),
        ],
        "fleet_insurances": [
            ("insurance_type", "TEXT", "TEXT"),
            ("provider", "TEXT", "TEXT"),
            ("policy_number", "TEXT", "TEXT"),
            ("status", "TEXT", "TEXT"),
            ("start_date", "TIMESTAMP", "TEXT"),
            ("expiry_date", "TIMESTAMP", "TEXT"),
            ("premium_amount", "DOUBLE PRECISION", "REAL"),
            ("currency", "TEXT", "TEXT"),
            ("deductible", "DOUBLE PRECISION", "REAL"),
            ("reminder_days_before", "INTEGER", "INTEGER"),
            ("remind_at", "TIMESTAMP", "TEXT"),
            ("last_reminder_at", "TIMESTAMP", "TEXT"),
            ("notes", "TEXT", "TEXT"),
            ("data", "JSONB", "JSON"),
            ("created_at", "TIMESTAMP", "TEXT"),
            ("updated_at", "TIMESTAMP", "TEXT"),
        ],
    }

    if dialect == "postgresql":
        for table_name, columns in table_specs.items():
            try:
                exists = db.execute(
                    text("SELECT 1 FROM information_schema.tables WHERE table_name = :t LIMIT 1"),
                    {"t": table_name},
                ).fetchone()
            except Exception:
                exists = None
            if not exists:
                continue
            for name, pg_type, _sqlite_type in columns:
                db.execute(text(f"ALTER TABLE {table_name} ADD COLUMN IF NOT EXISTS {name} {pg_type}"))
        db.commit()
        return

    if dialect == "sqlite":
        for table_name, columns in table_specs.items():
            try:
                exists = db.execute(
                    text("SELECT name FROM sqlite_master WHERE type='table' AND name=:t LIMIT 1"),
                    {"t": table_name},
                ).fetchone()
            except Exception:
                exists = None
            if not exists:
                continue

            existing = [row[1] for row in db.execute(text(f"PRAGMA table_info({table_name})")).fetchall()]
            for name, _pg_type, sqlite_type in columns:
                if name in existing:
                    continue
                db.execute(text(f"ALTER TABLE {table_name} ADD COLUMN {name} {sqlite_type}"))
            db.commit()


def sync_vehicles_from_drivers(db: Session) -> int:
    """
    Keep fleet vehicles in sync with driver allocations.

    - Upserts by truck plate when available.
    - Falls back to assigned_driver_id when plate is missing.
    """
    if not ensure_fleet_schema(db):
        return 0

    updated = 0
    existing_rows = db.query(models.FleetVehicle).all()
    by_plate: Dict[str, models.FleetVehicle] = {}
    by_driver: Dict[str, models.FleetVehicle] = {}
    for row in existing_rows:
        p = _normalize_plate(getattr(row, "plate", None))
        d = _driver_id_key(getattr(row, "assigned_driver_id", None))
        if p:
            by_plate[p] = row
        if d:
            by_driver[d] = row

    rows = (
        db.query(models.Driver)
        .filter(models.Driver.active.is_(True))
        .filter(
            or_(
                models.Driver.truck_plate.isnot(None),
                models.Driver.vehicle_type_code.isnot(None),
                models.Driver.role == authz.ROLE_DRIVER,
            )
        )
        .all()
    )
    for d in rows:
        role = authz.normalize_role(getattr(d, "role", None))
        if role == authz.ROLE_RECIPIENT:
            continue

        plate = _normalize_plate(getattr(d, "truck_plate", None))
        did = _driver_id_value(getattr(d, "driver_id", None))
        did_key = _driver_id_key(did)
        existing = None
        if plate:
            existing = by_plate.get(plate)
        if not existing and did_key:
            existing = by_driver.get(did_key)

        if not existing:
            existing = models.FleetVehicle()
            db.add(existing)
            db.flush()

        old_plate = _normalize_plate(getattr(existing, "plate", None))
        old_driver = _driver_id_key(getattr(existing, "assigned_driver_id", None))
        existing.plate = plate
        existing.active = True
        existing.assigned_driver_id = did
        existing.assigned_driver_name = _clean_str(getattr(d, "name", None))
        existing.assigned_phone = _clean_str(getattr(d, "phone_number", None))
        existing.helper_name = _clean_str(getattr(d, "helper_name", None))
        existing.vehicle_type_code = _clean_str(getattr(d, "vehicle_type_code", None))
        existing.vehicle_has_lift = bool(getattr(d, "vehicle_has_lift", False)) if getattr(d, "vehicle_has_lift", None) is not None else None
        existing.max_volume_m3 = _positive_float(getattr(d, "max_volume_m3", None))
        existing.target_volume_m3 = _positive_float(getattr(d, "target_volume_m3", None))
        existing.max_weight_kg = _positive_float(getattr(d, "max_weight_kg", None))
        existing.target_weight_kg = _positive_float(getattr(d, "target_weight_kg", None))
        if not existing.label:
            parts = [x for x in [existing.plate, existing.assigned_driver_name] if x]
            existing.label = " - ".join(parts) or None

        if old_plate and old_plate in by_plate and by_plate.get(old_plate) is existing:
            by_plate.pop(old_plate, None)
        if old_driver and old_driver in by_driver and by_driver.get(old_driver) is existing:
            by_driver.pop(old_driver, None)
        if plate:
            by_plate[plate] = existing
        if did_key:
            by_driver[did_key] = existing
        updated += 1

    if updated:
        db.commit()
    return updated


def list_vehicles(db: Session, *, include_inactive: bool = False) -> List[models.FleetVehicle]:
    q = db.query(models.FleetVehicle)
    if not include_inactive:
        q = q.filter(models.FleetVehicle.active.is_(True))
    return q.order_by(models.FleetVehicle.updated_at.desc(), models.FleetVehicle.id.desc()).all()


def _clean_phone_label(value: Any) -> Optional[str]:
    txt = _clean_str(value)
    if not txt:
        return None
    compact = txt.strip()
    if len(compact) > 120:
        compact = compact[:120]
    return compact or None


def _coord_pair(lat: Any, lon: Any) -> Optional[Tuple[float, float]]:
    try:
        la = float(lat)
        lo = float(lon)
    except Exception:
        return None
    if not (-90 <= la <= 90 and -180 <= lo <= 180):
        return None
    return float(la), float(lo)


def _haversine_km(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    lat1, lon1 = a
    lat2, lon2 = b
    r = 6371.0
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * (math.sin(dl / 2) ** 2)
    return max(0.0, 2 * r * math.asin(math.sqrt(h)))


def _vehicle_by_id_or_plate(
    db: Session,
    *,
    vehicle_id: Optional[int] = None,
    vehicle_plate: Optional[str] = None,
) -> Optional[models.FleetVehicle]:
    if vehicle_id is not None:
        try:
            vid = int(vehicle_id)
        except Exception:
            vid = 0
        if vid > 0:
            return db.query(models.FleetVehicle).filter(models.FleetVehicle.id == vid).first()

    plate = _normalize_plate(vehicle_plate)
    if plate:
        return db.query(models.FleetVehicle).filter(models.FleetVehicle.plate == plate).first()
    return None


def get_active_assignment(
    db: Session,
    *,
    driver_id: str,
    phone_label: Optional[str] = None,
) -> Optional[models.FleetVehicleAssignment]:
    did = _driver_id_value(driver_id)
    if not did:
        return None
    phone = _clean_phone_label(phone_label)

    if phone:
        row = (
            db.query(models.FleetVehicleAssignment)
            .filter(
                models.FleetVehicleAssignment.driver_id == did,
                models.FleetVehicleAssignment.active.is_(True),
                models.FleetVehicleAssignment.phone_label == phone,
            )
            .order_by(models.FleetVehicleAssignment.assigned_at.desc(), models.FleetVehicleAssignment.id.desc())
            .first()
        )
        if row:
            return row

    return (
        db.query(models.FleetVehicleAssignment)
        .filter(
            models.FleetVehicleAssignment.driver_id == did,
            models.FleetVehicleAssignment.active.is_(True),
        )
        .order_by(models.FleetVehicleAssignment.assigned_at.desc(), models.FleetVehicleAssignment.id.desc())
        .first()
    )


def deactivate_assignments(
    db: Session,
    *,
    driver_id: Optional[str] = None,
    vehicle_id: Optional[int] = None,
    phone_label: Optional[str] = None,
    now: Optional[datetime] = None,
) -> int:
    q = db.query(models.FleetVehicleAssignment).filter(models.FleetVehicleAssignment.active.is_(True))

    did = _driver_id_value(driver_id) if driver_id else None
    if did:
        q = q.filter(models.FleetVehicleAssignment.driver_id == did)

    if vehicle_id is not None:
        try:
            vid = int(vehicle_id)
        except Exception:
            vid = 0
        if vid > 0:
            q = q.filter(models.FleetVehicleAssignment.vehicle_id == vid)

    phone = _clean_phone_label(phone_label)
    if phone:
        q = q.filter(models.FleetVehicleAssignment.phone_label == phone)

    rows = q.all()
    if not rows:
        return 0
    ts = now or datetime.utcnow()
    changed = 0
    for row in rows:
        row.active = False
        row.unassigned_at = ts
        changed += 1
    return changed


def activate_assignment(
    db: Session,
    *,
    driver_id: str,
    vehicle: models.FleetVehicle,
    phone_label: Optional[str] = None,
    assigned_by_user_id: Optional[str] = None,
    source: Optional[str] = None,
    notes: Optional[str] = None,
    assigned_at: Optional[datetime] = None,
) -> models.FleetVehicleAssignment:
    if not ensure_fleet_schema(db):
        raise RuntimeError("Fleet schema unavailable")

    did = _driver_id_value(driver_id)
    if not did:
        raise ValueError("driver_id is required")
    if not vehicle or not getattr(vehicle, "id", None):
        raise ValueError("vehicle is required")

    now = assigned_at or datetime.utcnow()
    phone = _clean_phone_label(phone_label)
    vid = int(getattr(vehicle, "id", 0) or 0)
    plate = _normalize_plate(getattr(vehicle, "plate", None))

    existing = get_active_assignment(db, driver_id=did, phone_label=phone)
    if existing and int(getattr(existing, "vehicle_id", 0) or 0) == vid:
        if phone and str(getattr(existing, "phone_label", "") or "").strip() != phone:
            existing.phone_label = phone
        existing.vehicle_plate = plate
        if assigned_by_user_id:
            existing.assigned_by_user_id = _driver_id_value(assigned_by_user_id)
        if source:
            existing.source = _clean_str(source)
        if notes:
            existing.notes = _clean_str(notes)
        existing.assigned_at = now
        return existing

    deactivate_assignments(db, driver_id=did, now=now)
    if phone:
        deactivate_assignments(db, phone_label=phone, now=now)
    deactivate_assignments(db, vehicle_id=vid, now=now)

    row = models.FleetVehicleAssignment(
        driver_id=did,
        vehicle_id=vid,
        vehicle_plate=plate,
        phone_label=phone,
        active=True,
        assigned_at=now,
        unassigned_at=None,
        assigned_by_user_id=_driver_id_value(assigned_by_user_id),
        source=_clean_str(source),
        notes=_clean_str(notes),
        last_latitude=None,
        last_longitude=None,
        last_location_at=None,
        km_total=0.0,
    )
    db.add(row)
    db.flush()
    return row


def active_assignments(
    db: Session,
    *,
    driver_id: Optional[str] = None,
    vehicle_id: Optional[int] = None,
    limit: int = 100,
) -> List[models.FleetVehicleAssignment]:
    q = db.query(models.FleetVehicleAssignment).filter(models.FleetVehicleAssignment.active.is_(True))
    did = _driver_id_value(driver_id) if driver_id else None
    if did:
        q = q.filter(models.FleetVehicleAssignment.driver_id == did)
    if vehicle_id is not None:
        try:
            vid = int(vehicle_id)
        except Exception:
            vid = 0
        if vid > 0:
            q = q.filter(models.FleetVehicleAssignment.vehicle_id == vid)
    try:
        limit_n = int(limit or 100)
    except Exception:
        limit_n = 100
    limit_n = max(1, min(limit_n, 500))
    return q.order_by(models.FleetVehicleAssignment.assigned_at.desc(), models.FleetVehicleAssignment.id.desc()).limit(limit_n).all()


def apply_location_to_vehicle(
    db: Session,
    *,
    driver_id: str,
    latitude: float,
    longitude: float,
    now: Optional[datetime] = None,
    vehicle_id: Optional[int] = None,
    vehicle_plate: Optional[str] = None,
    phone_label: Optional[str] = None,
    assigned_by_user_id: Optional[str] = None,
    source: str = "driver_app",
) -> Dict[str, Any]:
    if not ensure_fleet_schema(db):
        return {
            "vehicle_id": None,
            "vehicle_plate": None,
            "assignment_id": None,
            "delta_km": 0.0,
            "vehicle_odometer_km": None,
        }

    did = _driver_id_value(driver_id)
    point = _coord_pair(latitude, longitude)
    if not did or not point:
        return {
            "vehicle_id": None,
            "vehicle_plate": None,
            "assignment_id": None,
            "delta_km": 0.0,
            "vehicle_odometer_km": None,
        }

    ts = now or datetime.utcnow()
    phone = _clean_phone_label(phone_label)

    payload_vehicle = _vehicle_by_id_or_plate(db, vehicle_id=vehicle_id, vehicle_plate=vehicle_plate)
    vehicle = None
    assignment = None

    # Manual phone assignment has priority over client-side plate hints.
    if phone:
        assignment = (
            db.query(models.FleetVehicleAssignment)
            .filter(
                models.FleetVehicleAssignment.driver_id == did,
                models.FleetVehicleAssignment.active.is_(True),
                models.FleetVehicleAssignment.phone_label == phone,
            )
            .order_by(models.FleetVehicleAssignment.assigned_at.desc(), models.FleetVehicleAssignment.id.desc())
            .first()
        )
        if assignment is not None:
            vehicle = db.query(models.FleetVehicle).filter(models.FleetVehicle.id == int(assignment.vehicle_id)).first()

    if assignment is None and payload_vehicle is not None:
        vehicle = payload_vehicle
        assignment = activate_assignment(
            db,
            driver_id=did,
            vehicle=vehicle,
            phone_label=phone,
            assigned_by_user_id=assigned_by_user_id or did,
            source=source,
            notes="Auto assignment from location ping",
            assigned_at=ts,
        )

    if assignment is None:
        assignment = get_active_assignment(db, driver_id=did, phone_label=None)
        if assignment is not None:
            vehicle = db.query(models.FleetVehicle).filter(models.FleetVehicle.id == int(assignment.vehicle_id)).first()

    if vehicle is None:
        vehicle = (
            db.query(models.FleetVehicle)
            .filter(models.FleetVehicle.active.is_(True), models.FleetVehicle.assigned_driver_id == did)
            .order_by(models.FleetVehicle.updated_at.desc(), models.FleetVehicle.id.desc())
            .first()
        )
        if vehicle is not None:
            assignment = activate_assignment(
                db,
                driver_id=did,
                vehicle=vehicle,
                phone_label=phone,
                assigned_by_user_id=assigned_by_user_id or did,
                source="fallback_assigned_driver",
                notes="Fallback from fleet vehicle assigned_driver_id",
                assigned_at=ts,
            )

    if not assignment or not vehicle:
        return {
            "vehicle_id": None,
            "vehicle_plate": None,
            "assignment_id": None,
            "delta_km": 0.0,
            "vehicle_odometer_km": None,
        }

    delta_km = 0.0
    prev_point = _coord_pair(getattr(assignment, "last_latitude", None), getattr(assignment, "last_longitude", None))
    prev_ts = getattr(assignment, "last_location_at", None)
    if prev_point and prev_ts:
        try:
            dt_s = max(0.0, float((ts - prev_ts).total_seconds()))
        except Exception:
            dt_s = 0.0
        if dt_s > 0:
            raw_dist = _haversine_km(prev_point, point)
            # Ignore obvious GPS jumps and stale intervals.
            max_speed_kmh = 160.0
            max_dist_for_dt = max(0.4, (dt_s / 3600.0) * max_speed_kmh)
            if dt_s <= 6 * 3600 and raw_dist <= max_dist_for_dt:
                delta_km = max(0.0, raw_dist)

    assignment.last_latitude = point[0]
    assignment.last_longitude = point[1]
    assignment.last_location_at = ts
    assignment.km_total = float(assignment.km_total or 0.0) + float(delta_km)
    assignment.vehicle_plate = _normalize_plate(getattr(vehicle, "plate", None))
    if phone and not str(getattr(assignment, "phone_label", "") or "").strip():
        assignment.phone_label = phone
    vehicle.assigned_driver_id = did
    if phone:
        vehicle.assigned_phone = phone

    if delta_km > 0:
        vehicle.odometer_km = float(vehicle.odometer_km or 0.0) + float(delta_km)

    return {
        "vehicle_id": int(getattr(vehicle, "id", 0) or 0) or None,
        "vehicle_plate": _normalize_plate(getattr(vehicle, "plate", None)),
        "assignment_id": int(getattr(assignment, "id", 0) or 0) or None,
        "delta_km": round(float(delta_km), 4),
        "vehicle_odometer_km": (round(float(vehicle.odometer_km), 4) if vehicle.odometer_km is not None else None),
    }


def refresh_compliance_statuses(db: Session, *, now: Optional[datetime] = None) -> Dict[str, int]:
    """
    Refresh status/reminder fields for docs/services/insurances.
    """
    now_dt = now or datetime.utcnow()

    docs_changed = 0
    for row in db.query(models.FleetDocument).all():
        next_status = _doc_status(row.expiry_date, now_dt)
        if row.status != next_status:
            row.status = next_status
            docs_changed += 1
        next_remind = _calc_remind_at(row.expiry_date, row.reminder_days_before)
        if row.remind_at != next_remind:
            row.remind_at = next_remind
            docs_changed += 1

    ins_changed = 0
    for row in db.query(models.FleetInsurancePolicy).all():
        next_status = _doc_status(row.expiry_date, now_dt, active_label="Active")
        if row.status != next_status:
            row.status = next_status
            ins_changed += 1
        next_remind = _calc_remind_at(row.expiry_date, row.reminder_days_before)
        if row.remind_at != next_remind:
            row.remind_at = next_remind
            ins_changed += 1

    svc_changed = 0
    vehicles = {
        int(v.id): v
        for v in db.query(models.FleetVehicle).all()
    }
    for row in db.query(models.FleetServiceRecord).all():
        odo_km = None
        try:
            vv = vehicles.get(int(row.vehicle_id))  # type: ignore[arg-type]
            if vv is not None:
                odo_km = _positive_float(vv.odometer_km)
        except Exception:
            odo_km = None

        next_status = _service_status(
            due_date=row.due_date,
            due_km=_positive_float(row.due_km),
            now=now_dt,
            odometer_km=odo_km,
            current_status=row.status,
        )
        if row.status != next_status:
            row.status = next_status
            svc_changed += 1

        next_remind = _calc_remind_at(row.due_date, row.reminder_days_before)
        if row.remind_at != next_remind:
            row.remind_at = next_remind
            svc_changed += 1

    if docs_changed or ins_changed or svc_changed:
        db.commit()

    return {
        "documents_changed": int(docs_changed),
        "insurances_changed": int(ins_changed),
        "services_changed": int(svc_changed),
    }


def fleet_overview(db: Session, *, days: int = 30, include_inactive: bool = False) -> Dict[str, Any]:
    ensure_fleet_schema(db)
    refresh_compliance_statuses(db)

    qv = db.query(models.FleetVehicle)
    if not include_inactive:
        qv = qv.filter(models.FleetVehicle.active.is_(True))
    vehicles = qv.all()

    total_target_volume = 0.0
    total_target_weight = 0.0
    with_lift = 0
    for v in vehicles:
        vol = _positive_float(v.target_volume_m3) or _positive_float(v.max_volume_m3) or 0.0
        kg = _positive_float(v.target_weight_kg) or _positive_float(v.max_weight_kg) or 0.0
        total_target_volume += float(vol)
        total_target_weight += float(kg)
        if bool(v.vehicle_has_lift):
            with_lift += 1

    now_dt = datetime.utcnow()
    due_before = now_dt + timedelta(days=max(0, int(days or 30)))

    reminders: List[Dict[str, Any]] = []
    docs = db.query(models.FleetDocument).join(models.FleetVehicle, models.FleetVehicle.id == models.FleetDocument.vehicle_id).all()
    for d in docs:
        when = d.expiry_date
        if not when:
            continue
        if when > due_before:
            continue
        reminders.append(
            {
                "kind": "document",
                "id": d.id,
                "vehicle_id": d.vehicle_id,
                "plate": _normalize_plate(getattr(d.vehicle, "plate", None)) if getattr(d, "vehicle", None) else None,
                "title": d.title,
                "status": d.status,
                "due_at": when,
                "days_left": _days_left(when, now_dt),
            }
        )

    ins = db.query(models.FleetInsurancePolicy).join(models.FleetVehicle, models.FleetVehicle.id == models.FleetInsurancePolicy.vehicle_id).all()
    for p in ins:
        when = p.expiry_date
        if not when:
            continue
        if when > due_before:
            continue
        reminders.append(
            {
                "kind": "insurance",
                "id": p.id,
                "vehicle_id": p.vehicle_id,
                "plate": _normalize_plate(getattr(p.vehicle, "plate", None)) if getattr(p, "vehicle", None) else None,
                "title": p.insurance_type or p.provider or "Insurance",
                "status": p.status,
                "due_at": when,
                "days_left": _days_left(when, now_dt),
            }
        )

    svcs = db.query(models.FleetServiceRecord).join(models.FleetVehicle, models.FleetVehicle.id == models.FleetServiceRecord.vehicle_id).all()
    for s in svcs:
        when = s.due_date
        if not when:
            continue
        if when > due_before:
            continue
        reminders.append(
            {
                "kind": "service",
                "id": s.id,
                "vehicle_id": s.vehicle_id,
                "plate": _normalize_plate(getattr(s.vehicle, "plate", None)) if getattr(s, "vehicle", None) else None,
                "title": s.title,
                "status": s.status,
                "due_at": when,
                "days_left": _days_left(when, now_dt),
            }
        )

    reminders.sort(key=lambda r: (r.get("due_at") or datetime.max, r.get("kind") or ""))
    overdue = [r for r in reminders if int(r.get("days_left") or 0) < 0]
    due_soon = [r for r in reminders if 0 <= int(r.get("days_left") or 0) <= max(0, int(days or 30))]

    by_type: Dict[str, int] = {}
    for v in vehicles:
        key = str(v.vehicle_type_code or "UNSET").strip().upper() or "UNSET"
        by_type[key] = by_type.get(key, 0) + 1

    return {
        "vehicles_total": len(vehicles),
        "vehicles_with_lift": int(with_lift),
        "target_volume_m3_total": round(float(total_target_volume), 2),
        "target_weight_kg_total": round(float(total_target_weight), 2),
        "by_vehicle_type": by_type,
        "reminders_total": len(reminders),
        "reminders_due_soon": len(due_soon),
        "reminders_overdue": len(overdue),
        "reminders": reminders[:200],
    }


def _calc_remind_at(due_at: Optional[datetime], reminder_days_before: Optional[int]) -> Optional[datetime]:
    if not due_at:
        return None
    days = int(reminder_days_before or 0)
    if days < 0:
        days = 0
    return due_at - timedelta(days=days)


def _doc_status(
    due_at: Optional[datetime],
    now: datetime,
    *,
    active_label: str = "Valid",
) -> str:
    if not due_at:
        return active_label
    delta = due_at - now
    if delta.total_seconds() < 0:
        return "Expired"
    if delta <= timedelta(days=30):
        return "ExpiringSoon"
    return active_label


def _service_status(
    *,
    due_date: Optional[datetime],
    due_km: Optional[float],
    now: datetime,
    odometer_km: Optional[float],
    current_status: Optional[str],
) -> str:
    status = str(current_status or "").strip()
    if status == "Done":
        return status

    if due_date:
        if due_date < now:
            return "Overdue"
        if due_date <= now + timedelta(days=14):
            return "DueSoon"

    if due_km is not None and odometer_km is not None:
        if odometer_km >= due_km:
            return "Overdue"
        if (due_km - odometer_km) <= 1000:
            return "DueSoon"

    return "Planned"


def _days_left(due_at: datetime, now: datetime) -> int:
    return int((due_at.date() - now.date()).days)


def _clean_str(value: Any) -> Optional[str]:
    s = str(value or "").strip()
    return s or None


def _normalize_plate(value: Any) -> Optional[str]:
    s = str(value or "").strip().upper()
    return s or None


def _driver_id_value(value: Any) -> Optional[str]:
    s = str(value or "").strip()
    return s or None


def _driver_id_key(value: Any) -> Optional[str]:
    raw = _driver_id_value(value)
    return raw.upper() if raw else None


def _positive_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        n = float(value)
    except Exception:
        return None
    if n <= 0:
        return None
    return n
