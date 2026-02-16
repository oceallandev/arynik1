from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

try:
    from .. import models
except ImportError:  # pragma: no cover
    import models  # type: ignore


def ensure_route_runs_schema(db: Session) -> bool:
    """
    Create route run tables if missing.
    """
    try:
        models.RouteRun.__table__.create(bind=db.get_bind(), checkfirst=True)
        models.RouteRunStop.__table__.create(bind=db.get_bind(), checkfirst=True)
        return True
    except Exception:
        return False


def start_run(
    db: Session,
    *,
    route_id: Optional[str],
    route_name: Optional[str],
    awbs: List[str],
    driver_id: str,
    truck_plate: Optional[str],
    helper_name: Optional[str],
    created_by_role: Optional[str],
    data: Optional[Dict[str, Any]] = None,
) -> Optional[models.RouteRun]:
    if not ensure_route_runs_schema(db):
        return None

    now = datetime.utcnow()
    run = models.RouteRun(
        created_at=now,
        started_at=now,
        ended_at=None,
        status="Active",
        route_id=(str(route_id or "").strip() or None),
        route_name=(str(route_name or "").strip() or None),
        driver_id=str(driver_id or "").strip(),
        truck_plate=(str(truck_plate or "").strip().upper() or None),
        helper_name=(str(helper_name or "").strip() or None),
        data=data,
    )
    db.add(run)
    db.flush()

    clean_awbs: List[str] = []
    seen = set()
    for awb in awbs or []:
        key = str(awb or "").strip().upper()
        if not key or key in seen:
            continue
        seen.add(key)
        clean_awbs.append(key)

    for idx, awb in enumerate(clean_awbs):
        db.add(
            models.RouteRunStop(
                run_id=run.id,
                awb=awb,
                seq=idx + 1,
                state="Pending",
                arrived_at=None,
                completed_at=None,
                completion_event_id=None,
                last_latitude=None,
                last_longitude=None,
                notes=None,
                data=None,
            )
        )

    return run


def get_run(db: Session, run_id: int) -> Optional[models.RouteRun]:
    if not ensure_route_runs_schema(db):
        return None
    try:
        rid = int(run_id)
    except Exception:
        return None
    return db.query(models.RouteRun).filter(models.RouteRun.id == rid).first()


def list_active_runs(db: Session, *, limit: int = 50) -> List[models.RouteRun]:
    if not ensure_route_runs_schema(db):
        return []
    try:
        limit_n = int(limit or 50)
    except Exception:
        limit_n = 50
    limit_n = max(1, min(limit_n, 200))
    return (
        db.query(models.RouteRun)
        .filter(models.RouteRun.status == "Active")
        .order_by(models.RouteRun.started_at.desc().nullslast(), models.RouteRun.created_at.desc())
        .limit(limit_n)
        .all()
    )


def _get_stop(db: Session, *, run_id: int, awb: str) -> Optional[models.RouteRunStop]:
    return (
        db.query(models.RouteRunStop)
        .filter(models.RouteRunStop.run_id == int(run_id), models.RouteRunStop.awb == str(awb or "").strip().upper())
        .first()
    )


def mark_arrived(
    db: Session,
    *,
    run_id: int,
    awb: str,
    latitude: Optional[float] = None,
    longitude: Optional[float] = None,
    notes: Optional[str] = None,
    data: Optional[Dict[str, Any]] = None,
) -> Optional[models.RouteRunStop]:
    if not ensure_route_runs_schema(db):
        return None
    stop = _get_stop(db, run_id=run_id, awb=awb)
    if not stop:
        return None

    now = datetime.utcnow()
    if stop.arrived_at is None:
        stop.arrived_at = now
    stop.state = "Arrived" if stop.state not in ("Done", "Skipped") else stop.state
    if latitude is not None and longitude is not None:
        stop.last_latitude = float(latitude)
        stop.last_longitude = float(longitude)
    if notes is not None:
        stop.notes = str(notes or "").strip() or None
    if data is not None:
        stop.data = data
    return stop


def mark_completed(
    db: Session,
    *,
    run_id: int,
    awb: str,
    completion_event_id: Optional[str] = None,
    latitude: Optional[float] = None,
    longitude: Optional[float] = None,
    notes: Optional[str] = None,
    data: Optional[Dict[str, Any]] = None,
) -> Optional[models.RouteRunStop]:
    if not ensure_route_runs_schema(db):
        return None
    stop = _get_stop(db, run_id=run_id, awb=awb)
    if not stop:
        return None

    now = datetime.utcnow()
    if stop.arrived_at is None:
        stop.arrived_at = now
    stop.completed_at = now
    stop.state = "Done"
    stop.completion_event_id = str(completion_event_id or "").strip() or None
    if latitude is not None and longitude is not None:
        stop.last_latitude = float(latitude)
        stop.last_longitude = float(longitude)
    if notes is not None:
        stop.notes = str(notes or "").strip() or None
    if data is not None:
        stop.data = data
    return stop


def mark_skipped(
    db: Session,
    *,
    run_id: int,
    awb: str,
    latitude: Optional[float] = None,
    longitude: Optional[float] = None,
    notes: Optional[str] = None,
    data: Optional[Dict[str, Any]] = None,
) -> Optional[models.RouteRunStop]:
    if not ensure_route_runs_schema(db):
        return None
    stop = _get_stop(db, run_id=run_id, awb=awb)
    if not stop:
        return None

    now = datetime.utcnow()
    if stop.arrived_at is None:
        stop.arrived_at = now
    stop.completed_at = now
    stop.state = "Skipped"
    if latitude is not None and longitude is not None:
        stop.last_latitude = float(latitude)
        stop.last_longitude = float(longitude)
    if notes is not None:
        stop.notes = str(notes or "").strip() or None
    if data is not None:
        stop.data = data
    return stop


def finish_run(db: Session, *, run: models.RouteRun) -> Optional[models.RouteRun]:
    if not run:
        return None
    now = datetime.utcnow()
    run.status = "Finished"
    run.ended_at = now
    return run

