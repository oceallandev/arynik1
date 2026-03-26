from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session, joinedload

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
    created_route_id = str(route_id or "").strip() or None
    created_driver_id = str(driver_id or "").strip()
    
    # Check if this exact route is already active for this driver to prevent progress loss
    existing = db.query(models.RouteRun).filter(
        models.RouteRun.driver_id == created_driver_id,
        models.RouteRun.route_id == created_route_id,
        models.RouteRun.status == "Active"
    ).order_by(models.RouteRun.created_at.desc()).first()
    
    if existing:
        return existing

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


def list_history_runs(db: Session, *, limit: int = 50) -> List[models.RouteRun]:
    if not ensure_route_runs_schema(db):
        return []
    try:
        limit_n = int(limit or 50)
    except Exception:
        limit_n = 50
    limit_n = max(1, min(limit_n, 200))
    return (
        db.query(models.RouteRun)
        .options(joinedload(models.RouteRun.stops))
        .filter(models.RouteRun.status.in_(["Finished", "Completed"]))
        .order_by(models.RouteRun.ended_at.desc().nullslast(), models.RouteRun.created_at.desc())
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


def mark_on_the_way(
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
    merged_data: Dict[str, Any] = {}
    if isinstance(getattr(stop, "data", None), dict):
        merged_data.update(getattr(stop, "data", None) or {})
    if isinstance(data, dict):
        merged_data.update(data)
    merged_data["on_the_way"] = True
    merged_data["tracking_visible"] = True
    merged_data["on_the_way_at"] = now.isoformat() + "Z"

    if str(stop.state or "").strip().lower() not in ("done", "skipped"):
        stop.state = "OnTheWay"
    if latitude is not None and longitude is not None:
        stop.last_latitude = float(latitude)
        stop.last_longitude = float(longitude)
    if notes is not None:
        stop.notes = str(notes or "").strip() or None
    stop.data = merged_data
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


def search_global_route_history(db: Session, query: str) -> List[Dict[str, Any]]:
    if not ensure_route_runs_schema(db):
        return []
        
    if not query or len(query.strip()) < 3:
        return []
    
    q = query.strip().lower()
    
    from sqlalchemy import or_, func
    matching_awbs = set()
    
    # 1. Matches in Shipments (AWB, Sender)
    shipments = db.query(models.Shipment).filter(
        or_(
            func.lower(models.Shipment.awb).contains(q),
            func.lower(models.Shipment.sender_shop_name).contains(q),
        )
    ).limit(50).all()
    
    for sh in shipments:
        if sh.awb:
            matching_awbs.add(sh.awb.upper())
            
    # 2. Matches in RouteRunStops (AWB) directly
    stops = db.query(models.RouteRunStop).filter(
        func.lower(models.RouteRunStop.awb).contains(q)
    ).limit(50).all()
    
    for st in stops:
        if st.awb:
            matching_awbs.add(st.awb.upper())
            
    if not matching_awbs:
        return []
        
    # Get all RouteRunStops for the matching AWBs 
    final_stops = db.query(models.RouteRunStop).options(
        joinedload(models.RouteRunStop.run)
    ).filter(
        models.RouteRunStop.awb.in_(list(matching_awbs))
    ).all()
    
    # Preload Shipment data to enrich
    shipments_dict = {
        sh.awb.upper(): sh 
        for sh in db.query(models.Shipment).filter(models.Shipment.awb.in_(list(matching_awbs))).all()
    }
    
    results = []
    for st in final_stops:
        sh = shipments_dict.get(st.awb.upper())
        recip_name = ""
        sender_name = ""
        processing_status = ""
        if sh:
            sender_name = sh.sender_shop_name or ""
            processing_status = sh.processing_status or ""
            if sh.raw_data:
                r_loc = sh.raw_data.get('recipientLocation', {})
                if r_loc:
                    recip_name = r_loc.get('name') or r_loc.get('personType') or ""
                
        results.append({
            "awb": st.awb,
            "route_run_id": st.run_id,
            "route_id": st.run.route_id if st.run else None,
            "route_name": st.run.route_name if st.run else "Unknown Route",
            "driver_id": st.run.driver_id if st.run else "Unknown",
            "truck_plate": st.run.truck_plate if st.run else None,
            "run_status": st.run.status if st.run else None,
            "run_started_at": st.run.started_at.isoformat() + "Z" if st.run and st.run.started_at else None,
            "run_ended_at": st.run.ended_at.isoformat() + "Z" if st.run and st.run.ended_at else None,
            "stop_state": st.state,
            "stop_arrived_at": st.arrived_at.isoformat() + "Z" if st.arrived_at else None,
            "stop_completed_at": st.completed_at.isoformat() + "Z" if st.completed_at else None,
            "stop_notes": st.notes,
            "recipient_name": recip_name,
            "sender_name": sender_name,
            "processing_status": processing_status,
        })
        
    # Sort results by run_started_at descending
    results.sort(key=lambda x: x["run_started_at"] or "", reverse=True)
    return results
