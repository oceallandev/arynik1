from __future__ import annotations

from datetime import datetime
import os
import unicodedata
from typing import Any, Dict, List, Optional
from io import BytesIO

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import cm
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

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

    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        rightMargin=1.5 * cm,
        leftMargin=1.5 * cm,
        topMargin=2 * cm,
        bottomMargin=2 * cm
    )

    styles = getSampleStyleSheet()
    
    # Register Roboto Fonts to support Romanian diacritics
    fonts_dir = os.path.join(os.path.dirname(__file__), "..", "fonts")
    try:
        pdfmetrics.registerFont(TTFont('Roboto', os.path.join(fonts_dir, 'Roboto-Regular.ttf')))
        pdfmetrics.registerFont(TTFont('Roboto-Bold', os.path.join(fonts_dir, 'Roboto-Bold.ttf')))
        pdfmetrics.registerFont(TTFont('Roboto-Italic', os.path.join(fonts_dir, 'Roboto-Italic.ttf')))
        font_regular = "Roboto"
        font_bold = "Roboto-Bold"
        font_italic = "Roboto-Italic"
    except Exception as e:
        # Fallback to defaults if font loading fails
        print(f"Warning: Failed to load Roboto fonts: {e}")
        font_regular = "Helvetica"
        font_bold = "Helvetica-Bold"
        font_italic = "Helvetica-Oblique"

    # Custom Styles
    style_title = ParagraphStyle(
        name="TitleBold",
        parent=styles["Heading1"],
        fontName=font_bold,
        fontSize=18,
        alignment=TA_CENTER,
        spaceAfter=6,
    )
    style_subtitle = ParagraphStyle(
        name="Subtitle",
        parent=styles["Normal"],
        fontName=font_regular,
        fontSize=10,
        alignment=TA_CENTER,
        textColor=colors.gray,
        spaceAfter=18,
    )
    style_normal = ParagraphStyle(
        name="NormalText",
        parent=styles["Normal"],
        fontName=font_regular,
        fontSize=9,
    )
    style_bold = ParagraphStyle(
        name="NormalBold",
        parent=styles["Normal"],
        fontName=font_bold,
        fontSize=9,
    )
    style_table_header = ParagraphStyle(
        name="TableHeader",
        parent=styles["Normal"],
        fontName=font_bold,
        fontSize=8,
        alignment=TA_CENTER,
    )
    style_table_cell = ParagraphStyle(
        name="TableCell",
        parent=styles["Normal"],
        fontName=font_regular,
        fontSize=8,
        leading=10,
    )
    style_table_cell_center = ParagraphStyle(
        name="TableCellCenter",
        parent=style_table_cell,
        alignment=TA_CENTER,
    )

    elements = []

    # Title
    elements.append(Paragraph("<b>AVIZ DE ÎNSOȚIRE A MĂRFII</b>", style_title))
    elements.append(Paragraph("Document logistic pentru distribuție - generat electronic", style_subtitle))
    
    aviz_no = str(getattr(row, 'aviz_number', '') or '-')
    elements.append(Paragraph(f"<b>Număr aviz:</b> {aviz_no}", style_normal))
    elements.append(Paragraph(f"<b>Data emiterii:</b> {issued_ts}", style_normal))
    elements.append(Spacer(1, 12))

    # Header section: Issuer | Transport
    company_name = str(issuer.get('name') or '-')
    company_cui = str(issuer.get('cui') or '-')
    company_reg = str(issuer.get('reg_com') or '-')
    company_address = f"{issuer.get('address') or '-'}, {issuer.get('city') or '-'}, {issuer.get('county') or '-'}"
    company_phone = str(issuer.get("phone") or "").strip()

    route_name = str(route.get('route_name') or getattr(row, 'route_name', '-') or '-')
    route_date = str(route.get('plan_date') or getattr(row, 'plan_date', '-') or '-')
    route_county = str(route.get('county') or getattr(row, 'county', '-') or '-')
    vehicle_plate = str(route.get('vehicle_plate') or getattr(row, 'vehicle_plate', '-') or '-')
    driver_name = str(route.get('driver_name') or getattr(row, 'driver_name', '-') or '-')
    driver_id = str(route.get('driver_id') or getattr(row, 'driver_id', '-') or '-')
    helper_name = str(route.get("helper_name") or getattr(row, "helper_name", None) or "")

    issuer_data = [
        Paragraph("<b>DATE EMITENT (FURNIZOR)</b>", style_bold),
        Paragraph(f"<b>Societate:</b> {company_name}", style_normal),
        Paragraph(f"<b>C.U.I:</b> {company_cui} / <b>Reg. Com:</b> {company_reg}", style_normal),
        Paragraph(f"<b>Sediu:</b> {company_address}", style_normal)
    ]
    if company_phone:
        issuer_data.append(Paragraph(f"<b>Telefon:</b> {company_phone}", style_normal))

    transport_data = [
        Paragraph("<b>DATE TRANSPORT</b>", style_bold),
        Paragraph(f"<b>Ruta:</b> {route_name} ({route_county})", style_normal),
        Paragraph(f"<b>Data rutei:</b> {route_date}", style_normal),
        Paragraph(f"<b>Auto:</b> {vehicle_plate}", style_normal),
        Paragraph(f"<b>Șofer:</b> {driver_name} ({driver_id})", style_normal)
    ]
    if helper_name:
        transport_data.append(Paragraph(f"<b>Manipulant:</b> {helper_name}", style_normal))

    header_table = Table([[issuer_data, transport_data]], colWidths=[9 * cm, 9 * cm])
    header_table.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING', (0, 0), (-1, -1), 0),
        ('RIGHTPADDING', (0, 0), (-1, -1), 0),
    ]))
    elements.append(header_table)
    elements.append(Spacer(1, 12))

    # Centralizator
    awb_count = int(totals.get('awb_count') or getattr(row, 'awb_count', 0) or 0)
    total_kg = float(totals.get('weight_kg') or getattr(row, 'total_weight_kg', 0.0) or 0.0)
    total_m3 = float(totals.get('volume_m3') or getattr(row, 'total_volume_m3', 0.0) or 0.0)
    
    summary_text = (
        f"<b>CENTRALIZATOR MĂRFURI:</b> &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"
        f"<b>Total AWB:</b> {awb_count} &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"
        f"<b>Total Greutate:</b> {total_kg:.3f} kg &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"
        f"<b>Total Volum:</b> {total_m3:.4f} m³"
    )
    elements.append(Paragraph(summary_text, style_normal))
    elements.append(Spacer(1, 8))

    # Details Table
    table_data = [
        [
            Paragraph("<b>Nr.</b>", style_table_header),
            Paragraph("<b>AWB</b>", style_table_header),
            Paragraph("<b>Destinatar</b>", style_table_header),
            Paragraph("<b>Localitate</b>", style_table_header),
            Paragraph("<b>Kg</b>", style_table_header),
            Paragraph("<b>m³</b>", style_table_header),
            Paragraph("<b>Conținut / Adresă</b>", style_table_header)
        ]
    ]

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
        
        description = f"<b>{content}</b><br/>{address}" if content else address
        if not description:
            description = "-"

        table_data.append([
            Paragraph(str(idx), style_table_cell_center),
            Paragraph(awb, style_table_cell_center),
            Paragraph(recipient, style_table_cell),
            Paragraph(locality, style_table_cell_center),
            Paragraph(f"{weight:.3f}", style_table_cell_center),
            Paragraph(f"{volume:.4f}", style_table_cell_center),
            Paragraph(description, style_table_cell)
        ])

    # Column widths (A4 width without margins = 21cm - 3cm = 18cm)
    col_widths = [1.0 * cm, 2.5 * cm, 3.5 * cm, 3.0 * cm, 1.2 * cm, 1.3 * cm, 5.5 * cm]
    
    items_table = Table(table_data, colWidths=col_widths, repeatRows=1)
    items_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor("#f0f0f0")),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.black),
        ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('INNERGRID', (0, 0), (-1, -1), 0.25, colors.gray),
        ('BOX', (0, 0), (-1, -1), 0.5, colors.black),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
    ]))
    
    elements.append(items_table)
    elements.append(Spacer(1, 20))

    # Legal note
    elements.append(Paragraph("<i>Observație: Documentul însoțește marfa pe toată durata transportului.</i>", style_normal))
    elements.append(Spacer(1, 20))

    # Footer Signatures Grid
    sig_data = [
        [
            Paragraph("<b>Semnătură și ștampilă emitent</b>", style_table_header),
            Paragraph("<b>Date privind expediția</b>", style_table_header),
            Paragraph("<b>Semnătură de primire</b>", style_table_header)
        ],
        [
            Paragraph("<br/><br/><br/>", style_normal),
            Paragraph(
                f"Numele delegatului (Șofer): <b>{driver_name}</b><br/><br/>"
                f"Mijloc de transport: <b>{vehicle_plate}</b><br/><br/>"
                f"Data expedierii: ............................ Ora: ........<br/><br/>"
                f"Semnătura delegatului: ............................",
                style_table_cell
            ),
            Paragraph("<br/><br/><br/>", style_normal)
        ]
    ]

    sig_table = Table(sig_data, colWidths=[6 * cm, 6 * cm, 6 * cm])
    sig_table.setStyle(TableStyle([
        ('ALIGN', (0, 0), (-1, 0), 'CENTER'),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('INNERGRID', (0, 0), (-1, -1), 0.25, colors.gray),
        ('BOX', (0, 0), (-1, -1), 0.5, colors.black),
        ('TOPPADDING', (0, 0), (-1, -1), 6),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
        ('RIGHTPADDING', (0, 0), (-1, -1), 6),
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor("#fafafa")),
    ]))
    
    # We want the footer to try and keep together on the same page if possible.
    elements.append(sig_table)

    doc.build(elements)
    
    return buffer.getvalue()
