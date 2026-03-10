from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

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
        d = str(getattr(row, "assigned_driver_id", "") or "").strip().upper() or None
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
        did = str(getattr(d, "driver_id", "") or "").strip().upper() or None
        existing = None
        if plate:
            existing = by_plate.get(plate)
        if not existing and did:
            existing = by_driver.get(did)

        if not existing:
            existing = models.FleetVehicle()
            db.add(existing)
            db.flush()

        old_plate = _normalize_plate(getattr(existing, "plate", None))
        old_driver = str(getattr(existing, "assigned_driver_id", "") or "").strip().upper() or None
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
        if did:
            by_driver[did] = existing
        updated += 1

    if updated:
        db.commit()
    return updated


def list_vehicles(db: Session, *, include_inactive: bool = False) -> List[models.FleetVehicle]:
    q = db.query(models.FleetVehicle)
    if not include_inactive:
        q = q.filter(models.FleetVehicle.active.is_(True))
    return q.order_by(models.FleetVehicle.updated_at.desc(), models.FleetVehicle.id.desc()).all()


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
