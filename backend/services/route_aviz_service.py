from __future__ import annotations

from datetime import datetime
import os
import unicodedata
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

try:
    from .. import models
except ImportError:  # pragma: no cover
    import models  # type: ignore


def ensure_route_avize_schema(db: Session) -> bool:
    try:
        models.RouteAviz.__table__.create(bind=db.get_bind(), checkfirst=True)
        return True
    except Exception:
        return False


def _safe_float(value: Any) -> Optional[float]:
    try:
        if value is None:
            return None
        if isinstance(value, str):
            raw = value.strip().replace(",", ".")
            if not raw:
                return None
            return float(raw)
        return float(value)
    except Exception:
        return None


def _normalize_awb(value: Any) -> str:
    return str(value or "").strip().upper()


def _ascii_text(value: Any) -> str:
    text = str(value or "")
    normalized = unicodedata.normalize("NFKD", text)
    return normalized.encode("ascii", "ignore").decode("ascii")


def _issuer_profile() -> Dict[str, str]:
    return {
        "name": str(os.getenv("AVIZ_ISSUER_NAME", os.getenv("COMPANY_NAME", "GreenWee Logistics")) or "GreenWee Logistics").strip(),
        "cui": str(os.getenv("AVIZ_ISSUER_CUI", os.getenv("COMPANY_CUI", "RO00000000")) or "RO00000000").strip(),
        "reg_com": str(os.getenv("AVIZ_ISSUER_REG_COM", os.getenv("COMPANY_REG_COM", "J00/0000/2000")) or "J00/0000/2000").strip(),
        "address": str(os.getenv("AVIZ_ISSUER_ADDRESS", os.getenv("COMPANY_ADDRESS", "Romania")) or "Romania").strip(),
        "city": str(os.getenv("AVIZ_ISSUER_CITY", os.getenv("COMPANY_CITY", "Bacau")) or "Bacau").strip(),
        "county": str(os.getenv("AVIZ_ISSUER_COUNTY", os.getenv("COMPANY_COUNTY", "Bacau")) or "Bacau").strip(),
        "phone": str(os.getenv("AVIZ_ISSUER_PHONE", os.getenv("COMPANY_PHONE", "")) or "").strip(),
    }


def _next_aviz_number(db: Session, *, now: Optional[datetime] = None) -> str:
    ts = now or datetime.utcnow()
    day_key = ts.strftime("%Y%m%d")
    prefix = f"AVZ-{day_key}-"
    max_seq = 0
    rows = db.query(models.RouteAviz.aviz_number).filter(models.RouteAviz.aviz_number.like(f"{prefix}%")).all()
    for (value,) in rows:
        raw = str(value or "").strip().upper()
        if not raw.startswith(prefix):
            continue
        tail = raw[len(prefix):]
        try:
            seq = int(tail)
        except Exception:
            continue
        if seq > max_seq:
            max_seq = seq
    return f"{prefix}{(max_seq + 1):04d}"


def _shipment_line(ship: Optional[models.Shipment], awb: str, idx: int) -> Dict[str, Any]:
    if not ship:
        return {
            "index": idx,
            "awb": awb,
            "recipient": "",
            "locality": "",
            "address": "",
            "content": "",
            "parcels": 0,
            "weight_kg": 0.0,
            "volume_m3": 0.0,
            "missing": True,
        }

    weight = _safe_float(getattr(ship, "weight", None)) or 0.0
    volume = _safe_float(getattr(ship, "volumetric_weight", None))
    if volume is not None:
        volume = max(0.0, volume / 250.0)
    else:
        volume = 0.0

    return {
        "index": idx,
        "awb": awb,
        "recipient": str(getattr(ship, "recipient_name", "") or "").strip(),
        "locality": str(getattr(ship, "locality", "") or "").strip(),
        "address": str(getattr(ship, "delivery_address", "") or "").strip(),
        "content": str(getattr(ship, "content_description", "") or "").strip(),
        "parcels": int(getattr(ship, "number_of_parcels", 0) or 0),
        "weight_kg": round(weight, 3),
        "volume_m3": round(float(volume or 0.0), 4),
        "missing": False,
    }


def route_aviz_to_dict(row: models.RouteAviz) -> Dict[str, Any]:
    return {
        "id": int(getattr(row, "id", 0) or 0),
        "created_at": getattr(row, "created_at", None),
        "created_by_user_id": getattr(row, "created_by_user_id", None),
        "route_plan_id": int(getattr(row, "route_plan_id", 0) or 0),
        "aviz_number": str(getattr(row, "aviz_number", "") or ""),
        "plan_date": getattr(row, "plan_date", None),
        "route_name": getattr(row, "route_name", None),
        "county": getattr(row, "county", None),
        "vehicle_plate": getattr(row, "vehicle_plate", None),
        "driver_id": getattr(row, "driver_id", None),
        "driver_name": getattr(row, "driver_name", None),
        "helper_name": getattr(row, "helper_name", None),
        "awb_count": int(getattr(row, "awb_count", 0) or 0),
        "total_weight_kg": _safe_float(getattr(row, "total_weight_kg", None)),
        "total_volume_m3": _safe_float(getattr(row, "total_volume_m3", None)),
        "data": getattr(row, "data", None),
    }


def issue_route_aviz(
    db: Session,
    *,
    plan: models.RoutePlan,
    created_by_user_id: Optional[str] = None,
) -> models.RouteAviz:
    if not ensure_route_avize_schema(db):
        raise RuntimeError("Route avize schema unavailable")

    awbs: List[str] = []
    seen: set[str] = set()
    for raw in (getattr(plan, "awbs", None) or []):
        awb = _normalize_awb(raw)
        if not awb or awb in seen:
            continue
        seen.add(awb)
        awbs.append(awb)

    shipments_by_awb: Dict[str, models.Shipment] = {}
    if awbs:
        rows = db.query(models.Shipment).filter(models.Shipment.awb.in_(awbs)).all()
        for row in rows:
            key = _normalize_awb(getattr(row, "awb", None))
            if key:
                shipments_by_awb[key] = row

    lines: List[Dict[str, Any]] = []
    total_weight = 0.0
    total_volume = 0.0
    missing_awbs: List[str] = []
    for idx, awb in enumerate(awbs, start=1):
        line = _shipment_line(shipments_by_awb.get(awb), awb, idx)
        lines.append(line)
        total_weight += float(line.get("weight_kg") or 0.0)
        total_volume += float(line.get("volume_m3") or 0.0)
        if line.get("missing"):
            missing_awbs.append(awb)

    issuer = _issuer_profile()
    now = datetime.utcnow()
    aviz_number = _next_aviz_number(db, now=now)

    payload = {
        "document_type": "aviz_de_insotire_a_marfii",
        "issued_at": now.isoformat() + "Z",
        "issuer": issuer,
        "route": {
            "plan_id": int(getattr(plan, "id", 0) or 0),
            "plan_date": str(getattr(plan, "plan_date", "") or "").strip() or None,
            "route_name": str(getattr(plan, "name", "") or "").strip() or None,
            "county": str(getattr(plan, "county", "") or "").strip() or None,
            "vehicle_plate": str(getattr(plan, "assigned_vehicle_plate", "") or "").strip().upper() or None,
            "driver_id": str(getattr(plan, "assigned_driver_id", "") or "").strip().upper() or None,
            "driver_name": str(getattr(plan, "assigned_driver_name", "") or "").strip() or None,
            "helper_name": str(getattr(plan, "assigned_helper_name", "") or "").strip() or None,
        },
        "totals": {
            "awb_count": len(awbs),
            "weight_kg": round(total_weight, 3),
            "volume_m3": round(total_volume, 4),
        },
        "shipments": lines,
        "missing_awbs": missing_awbs,
        "legal_note": "Document generat electronic in sistemul intern de distributie.",
    }

    row = models.RouteAviz(
        created_at=now,
        created_by_user_id=str(created_by_user_id or "").strip().upper() or None,
        route_plan_id=int(getattr(plan, "id", 0) or 0),
        aviz_number=aviz_number,
        plan_date=str(getattr(plan, "plan_date", "") or "").strip() or None,
        route_name=str(getattr(plan, "name", "") or "").strip() or None,
        county=str(getattr(plan, "county", "") or "").strip() or None,
        vehicle_plate=str(getattr(plan, "assigned_vehicle_plate", "") or "").strip().upper() or None,
        driver_id=str(getattr(plan, "assigned_driver_id", "") or "").strip().upper() or None,
        driver_name=str(getattr(plan, "assigned_driver_name", "") or "").strip() or None,
        helper_name=str(getattr(plan, "assigned_helper_name", "") or "").strip() or None,
        awb_count=len(awbs),
        total_weight_kg=round(total_weight, 3),
        total_volume_m3=round(total_volume, 4),
        data=payload,
    )
    db.add(row)
    return row


def list_route_avize_for_plan(db: Session, *, plan_id: int, limit: int = 100) -> List[models.RouteAviz]:
    if not ensure_route_avize_schema(db):
        return []
    limit_n = max(1, min(int(limit or 100), 300))
    return (
        db.query(models.RouteAviz)
        .filter(models.RouteAviz.route_plan_id == int(plan_id))
        .order_by(models.RouteAviz.created_at.desc(), models.RouteAviz.id.desc())
        .limit(limit_n)
        .all()
    )


def list_route_avize(db: Session, *, plan_id: Optional[int] = None, limit: int = 100) -> List[models.RouteAviz]:
    if not ensure_route_avize_schema(db):
        return []
    limit_n = max(1, min(int(limit or 100), 500))
    q = db.query(models.RouteAviz)
    if plan_id is not None:
        q = q.filter(models.RouteAviz.route_plan_id == int(plan_id))
    return q.order_by(models.RouteAviz.created_at.desc(), models.RouteAviz.id.desc()).limit(limit_n).all()


def get_route_aviz(db: Session, aviz_id: int) -> Optional[models.RouteAviz]:
    if not ensure_route_avize_schema(db):
        return None
    try:
        aid = int(aviz_id)
    except Exception:
        return None
    return db.query(models.RouteAviz).filter(models.RouteAviz.id == aid).first()


def _wrap_line(text: str, width: int = 98) -> List[str]:
    words = [w for w in str(text or "").split(" ") if w]
    if not words:
        return [""]

    out: List[str] = []
    current = ""
    for word in words:
        candidate = word if not current else f"{current} {word}"
        if len(candidate) <= max(20, int(width)):
            current = candidate
            continue
        if current:
            out.append(current)
            current = word
        else:
            # hard split long token
            step = max(10, int(width))
            start = 0
            while start < len(word):
                out.append(word[start:start + step])
                start += step
            current = ""
    if current:
        out.append(current)
    return out


def _pdf_escape(text: str) -> str:
    return str(text or "").replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def _render_text_pdf(lines: List[str], *, title: str = "Document") -> bytes:
    # Lightweight PDF generator with built-in Helvetica font (no external dependency).
    page_height = 842
    start_y = 800
    line_step = 12
    max_lines = 60

    normalized_lines = [_ascii_text(x) for x in (lines or [])]
    if not normalized_lines:
        normalized_lines = [_ascii_text(title)]

    pages: List[List[str]] = []
    for idx in range(0, len(normalized_lines), max_lines):
        pages.append(normalized_lines[idx:idx + max_lines])

    objects: List[bytes] = []

    # 1: catalog, 2: pages, 3: font
    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")

    kids_ids: List[int] = []
    page_objects: List[bytes] = []
    content_objects: List[bytes] = []

    next_id = 4
    for page_lines in pages:
        page_id = next_id
        content_id = next_id + 1
        next_id += 2
        kids_ids.append(page_id)

        stream_lines = [
            "BT",
            "/F1 9 Tf",
            f"40 {start_y} Td",
            f"{line_step} TL",
        ]
        first = True
        for line in page_lines:
            escaped = _pdf_escape(line)
            if first:
                stream_lines.append(f"({escaped}) Tj")
                first = False
            else:
                stream_lines.append("T*")
                stream_lines.append(f"({escaped}) Tj")
        stream_lines.append("ET")
        stream_bytes = "\n".join(stream_lines).encode("latin-1", "replace")
        content_obj = (
            f"<< /Length {len(stream_bytes)} >>\nstream\n".encode("latin-1")
            + stream_bytes
            + b"\nendstream"
        )
        content_objects.append(content_obj)

        page_obj = f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 {page_height}] /Resources << /Font << /F1 3 0 R >> >> /Contents {content_id} 0 R >>".encode("latin-1")
        page_objects.append(page_obj)

    kids_ref = " ".join(f"{pid} 0 R" for pid in kids_ids)
    objects.append(f"<< /Type /Pages /Kids [{kids_ref}] /Count {len(kids_ids)} >>".encode("latin-1"))
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

    for i in range(len(page_objects)):
        objects.append(page_objects[i])
        objects.append(content_objects[i])

    out = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"
    offsets = [0]
    for idx, obj in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{idx} 0 obj\n".encode("latin-1")
        out += obj
        out += b"\nendobj\n"

    xref_start = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode("latin-1")
    out += b"0000000000 65535 f \n"
    for off in offsets[1:]:
        out += f"{off:010d} 00000 n \n".encode("latin-1")
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_start}\n%%EOF".encode("latin-1")
    return out


def build_route_aviz_pdf(row: models.RouteAviz) -> bytes:
    payload = row.data if isinstance(row.data, dict) else {}
    issuer = payload.get("issuer") if isinstance(payload.get("issuer"), dict) else {}
    route = payload.get("route") if isinstance(payload.get("route"), dict) else {}
    totals = payload.get("totals") if isinstance(payload.get("totals"), dict) else {}
    shipments = payload.get("shipments") if isinstance(payload.get("shipments"), list) else []

    created_at = getattr(row, "created_at", None)
    if isinstance(created_at, datetime):
        issued_ts = created_at.strftime("%Y-%m-%d %H:%M")
    else:
        issued_ts = str(payload.get("issued_at") or "").strip() or datetime.utcnow().strftime("%Y-%m-%d %H:%M")

    lines: List[str] = []
    lines.append("AVIZ DE INSOTIRE A MARFII")
    lines.append("Document logistic pentru distributie - generat electronic")
    lines.append("")
    lines.append(f"Numar aviz: {str(getattr(row, 'aviz_number', '') or '-')}")
    lines.append(f"Data emiterii: {issued_ts}")
    lines.append("")
    lines.append("DATE EMITENT")
    lines.append(f"Societate: {issuer.get('name') or '-'}")
    lines.append(f"CUI: {issuer.get('cui') or '-'}    Reg. Com.: {issuer.get('reg_com') or '-'}")
    lines.append(
        f"Sediu: {issuer.get('address') or '-'}, {issuer.get('city') or '-'}, {issuer.get('county') or '-'}"
    )
    phone = str(issuer.get("phone") or "").strip()
    if phone:
        lines.append(f"Telefon: {phone}")
    lines.append("")
    lines.append("DATE TRANSPORT")
    lines.append(f"Ruta: {route.get('route_name') or getattr(row, 'route_name', '-') or '-'}")
    lines.append(f"Data ruta: {route.get('plan_date') or getattr(row, 'plan_date', '-') or '-'}    Judet: {route.get('county') or getattr(row, 'county', '-') or '-'}")
    lines.append(f"Auto: {route.get('vehicle_plate') or getattr(row, 'vehicle_plate', '-') or '-'}")
    lines.append(
        f"Sofer: {route.get('driver_name') or getattr(row, 'driver_name', '-') or '-'} "
        f"({route.get('driver_id') or getattr(row, 'driver_id', '-') or '-'})"
    )
    helper_name = route.get("helper_name") or getattr(row, "helper_name", None)
    if helper_name:
        lines.append(f"Manipulant: {helper_name}")
    lines.append("")
    lines.append("CENTRALIZATOR MARFA")
    lines.append(
        f"Total AWB: {int(totals.get('awb_count') or getattr(row, 'awb_count', 0) or 0)}    "
        f"Total kg: {float(totals.get('weight_kg') or getattr(row, 'total_weight_kg', 0.0) or 0.0):.3f}    "
        f"Total m3: {float(totals.get('volume_m3') or getattr(row, 'total_volume_m3', 0.0) or 0.0):.4f}"
    )
    lines.append("")
    lines.append("Nr | AWB | Destinatar | Localitate | Kg | m3 | Continut/Adresa")

    for idx, item in enumerate(shipments, start=1):
        if not isinstance(item, dict):
            continue
        awb = str(item.get("awb") or "").strip() or "-"
        recipient = str(item.get("recipient") or "").strip() or "-"
        locality = str(item.get("locality") or "").strip() or "-"
        weight = _safe_float(item.get("weight_kg")) or 0.0
        volume = _safe_float(item.get("volume_m3")) or 0.0
        content = str(item.get("content") or "").strip()
        address = str(item.get("address") or "").strip()
        description = content if content else "-"
        if address:
            description = f"{description} | {address}" if description != "-" else address
        prefix = f"{idx:03d} | {awb} | {recipient[:26]} | {locality[:18]} | {weight:>7.3f} | {volume:>7.4f} | "
        wrapped = _wrap_line(description, width=max(25, 102 - len(prefix)))
        if wrapped:
            lines.append(prefix + wrapped[0])
            for extra in wrapped[1:]:
                lines.append(" " * len(prefix) + extra)
        else:
            lines.append(prefix + "-")

    lines.append("")
    lines.append("Observatie: Documentul insoteste marfa pe durata transportului.")
    lines.append("Semnatura emitent: ____________________")
    lines.append("Semnatura transportator (sofer): ____________________")
    lines.append("Semnatura primitor: ____________________")

    return _render_text_pdf(lines, title="Aviz de insotire a marfii")
