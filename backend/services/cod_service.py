from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

try:
    from .. import models
except ImportError:  # pragma: no cover
    import models  # type: ignore


def _as_float(value: Any) -> Optional[float]:
    try:
        if value is None or value == "":
            return None
        return float(value)
    except Exception:
        return None


def _payload_cod_amount(payload: Any) -> Optional[float]:
    if not isinstance(payload, dict):
        return None
    cod = payload.get("cod")
    if not isinstance(cod, dict):
        return None
    return _as_float(
        cod.get("amount_collected")
        if cod.get("amount_collected") is not None
        else (cod.get("amount") if cod.get("amount") is not None else cod.get("collected_amount"))
    )


def _payload_cod_method(payload: Any) -> Optional[str]:
    if not isinstance(payload, dict):
        return None
    cod = payload.get("cod")
    if not isinstance(cod, dict):
        return None
    method = cod.get("method") or cod.get("payment_method")
    m = str(method or "").strip()
    return m or None


def _payload_cod_ref(payload: Any) -> Optional[str]:
    if not isinstance(payload, dict):
        return None
    cod = payload.get("cod")
    if not isinstance(cod, dict):
        return None
    ref = cod.get("reference") or cod.get("ref") or cod.get("note")
    r = str(ref or "").strip()
    return r or None


def compute_cod_report(
    db: Session,
    *,
    date_from: Optional[datetime] = None,
    date_to: Optional[datetime] = None,
    driver_id: Optional[str] = None,
    limit: int = 2000,
) -> Dict[str, Any]:
    """
    COD reconciliation is computed from:
    - shipments.cod_amount (expected)
    - delivered logs (event_id=2) payload.cod.amount_collected (collected)
    - transfer logs (event_id=R3) payload.cod... (transferred)
    """
    did = str(driver_id or "").strip().upper() or None

    try:
        limit_n = int(limit or 2000)
    except Exception:
        limit_n = 2000
    limit_n = max(50, min(limit_n, 5000))

    logs_q = (
        db.query(models.LogEntry)
        .filter(models.LogEntry.event_id.in_(["2", "R3"]))
        .order_by(models.LogEntry.timestamp.desc())
    )
    if did:
        logs_q = logs_q.filter(models.LogEntry.driver_id == did)
    if date_from is not None:
        logs_q = logs_q.filter(models.LogEntry.timestamp >= date_from)
    if date_to is not None:
        logs_q = logs_q.filter(models.LogEntry.timestamp <= date_to)

    logs = logs_q.limit(limit_n).all()

    # Latest delivered log per AWB (and transfers list).
    delivered_by_awb: Dict[str, models.LogEntry] = {}
    transfers: List[models.LogEntry] = []
    awbs_seen: set[str] = set()

    for log in logs:
        awb = str(getattr(log, "awb", "") or "").strip().upper()
        if not awb:
            continue
        if str(getattr(log, "event_id", "") or "") == "R3":
            transfers.append(log)
            continue
        # event_id=2
        if awb not in delivered_by_awb:
            delivered_by_awb[awb] = log
        awbs_seen.add(awb)

    shipments_q = db.query(models.Shipment)
    if did:
        shipments_q = shipments_q.filter(models.Shipment.driver_id == did)
    # Only keep shipments with non-zero COD.
    shipments = (
        shipments_q
        .filter(models.Shipment.cod_amount.isnot(None))
        .filter(models.Shipment.cod_amount != 0)
        .order_by(models.Shipment.last_updated.desc().nullslast())
        .limit(limit_n)
        .all()
    )

    drivers_by_id: Dict[str, models.Driver] = {}
    driver_rows = db.query(models.Driver).all()
    for d in driver_rows:
        key = str(getattr(d, "driver_id", "") or "").strip().upper()
        if key:
            drivers_by_id[key] = d

    items: List[Dict[str, Any]] = []
    by_driver: Dict[str, Dict[str, Any]] = {}

    def driver_bucket(did_val: Optional[str]) -> Dict[str, Any]:
        key = str(did_val or "").strip().upper() or "UNASSIGNED"
        row = by_driver.get(key)
        if row:
            return row
        d = drivers_by_id.get(key)
        row = {
            "driver_id": key if key != "UNASSIGNED" else None,
            "name": getattr(d, "name", None) if d else None,
            "truck_plate": (str(getattr(d, "truck_plate", "") or "").strip().upper() or None) if d else None,
            "shipments": 0,
            "expected_total": 0.0,
            "collected_total": 0.0,
            "delta_total": 0.0,
        }
        by_driver[key] = row
        return row

    for ship in shipments:
        awb = str(getattr(ship, "awb", "") or "").strip().upper()
        if not awb:
            continue
        expected = _as_float(getattr(ship, "cod_amount", None)) or 0.0
        if expected == 0:
            continue

        delivered_log = delivered_by_awb.get(awb)
        payload = getattr(delivered_log, "payload", None) if delivered_log else None
        collected = _payload_cod_amount(payload)
        method = _payload_cod_method(payload)
        ref = _payload_cod_ref(payload)

        collected_val = float(collected) if collected is not None else None
        delta = (collected_val - expected) if collected_val is not None else None

        driver_val = str(getattr(ship, "driver_id", "") or "").strip().upper() or None
        drow = driver_bucket(driver_val)

        drow["shipments"] += 1
        drow["expected_total"] += float(expected)
        if collected_val is not None:
            drow["collected_total"] += float(collected_val)
            drow["delta_total"] += float(collected_val - expected)

        items.append(
            {
                "awb": awb,
                "driver_id": driver_val,
                "recipient_name": getattr(ship, "recipient_name", None),
                "cod_expected": float(expected),
                "cod_collected": collected_val,
                "cod_method": method,
                "cod_reference": ref,
                "delivered_at": getattr(delivered_log, "timestamp", None).isoformat() if delivered_log and getattr(delivered_log, "timestamp", None) else None,
                "delta": float(delta) if delta is not None else None,
            }
        )

    by_driver_list = list(by_driver.values())
    by_driver_list.sort(key=lambda r: str(r.get("driver_id") or "ZZZ"))

    # Transfer summary (R3).
    transfers_out: List[Dict[str, Any]] = []
    for log in transfers[: min(2000, len(transfers))]:
        awb = str(getattr(log, "awb", "") or "").strip().upper() or None
        payload = getattr(log, "payload", None)
        transfers_out.append(
            {
                "id": getattr(log, "id", None),
                "timestamp": getattr(log, "timestamp", None).isoformat() if getattr(log, "timestamp", None) else None,
                "driver_id": str(getattr(log, "driver_id", "") or "").strip().upper() or None,
                "awb": awb,
                "amount": _payload_cod_amount(payload),
                "method": _payload_cod_method(payload),
                "reference": _payload_cod_ref(payload),
                "outcome": getattr(log, "outcome", None),
            }
        )

    totals = {
        "shipments": sum(int(r.get("shipments") or 0) for r in by_driver_list),
        "expected_total": round(sum(float(r.get("expected_total") or 0) for r in by_driver_list), 2),
        "collected_total": round(sum(float(r.get("collected_total") or 0) for r in by_driver_list), 2),
        "delta_total": round(sum(float(r.get("delta_total") or 0) for r in by_driver_list), 2),
        "transfers": len(transfers_out),
    }

    return {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "driver_id": did,
        "totals": totals,
        "by_driver": by_driver_list,
        "shipments": items,
        "transfers": transfers_out,
    }

