from __future__ import annotations

import io
import os
import unicodedata
from datetime import datetime
from typing import Any, Dict, Optional

try:
    from reportlab.graphics import renderPDF
    from reportlab.graphics.barcode import code128, qr
    from reportlab.graphics.shapes import Drawing
    from reportlab.lib import colors
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen import canvas

    REPORTLAB_AVAILABLE = True
except Exception:  # pragma: no cover
    REPORTLAB_AVAILABLE = False

try:
    from .. import models
except ImportError:  # pragma: no cover
    import models  # type: ignore


PAGE_W = 288.0   # 4in
PAGE_H = 432.0   # 6in


def is_local_shipment(ship: Optional[models.Shipment]) -> bool:
    if ship is None:
        return False
    return bool(getattr(ship, "local_shipment", False) or getattr(ship, "local_awb_shipment", False))


def _as_text(value: Any, *, fallback: str = "-", max_len: int = 180) -> str:
    s = str(value or "").strip()
    if not s:
        s = fallback
    if len(s) > max_len:
        s = s[: max_len - 3].rstrip() + "..."
    return s


def _ascii_text(value: Any, *, fallback: str = "-", max_len: int = 180) -> str:
    raw = _as_text(value, fallback=fallback, max_len=max_len)
    folded = unicodedata.normalize("NFKD", raw).encode("ascii", "ignore").decode("ascii")
    return folded or fallback


def _draw_wrapped(
    c: canvas.Canvas,
    text: str,
    x: float,
    y_top: float,
    *,
    width: float,
    font_name: str,
    font_size: float,
    max_lines: int,
    leading: float,
) -> None:
    words = [w for w in _ascii_text(text, max_len=320).split(" ") if w]
    if not words:
        words = ["-"]

    lines = []
    current = ""
    for w in words:
        candidate = w if not current else f"{current} {w}"
        if c.stringWidth(candidate, font_name, font_size) <= width:
            current = candidate
            continue
        if current:
            lines.append(current)
            if len(lines) >= max_lines:
                break
        current = w

    if len(lines) < max_lines and current:
        lines.append(current)

    if not lines:
        lines = ["-"]
    if len(lines) > max_lines:
        lines = lines[:max_lines]

    # add ellipsis if truncated
    if len(lines) == max_lines:
        joined = " ".join(lines)
        if len(joined) < len(" ".join(words)):
            tail = lines[-1]
            while tail and c.stringWidth(f"{tail}...", font_name, font_size) > width:
                tail = tail[:-1]
            lines[-1] = f"{tail}..." if tail else "..."

    c.setFont(font_name, font_size)
    y = y_top
    for line in lines:
        c.drawString(x, y, line)
        y -= leading


def _draw_logo(c: canvas.Canvas, x: float, y: float, w: float, h: float) -> None:
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    candidates = [
        os.path.join(root, "logo-horizontal.png"),
        os.path.join(root, "logo.png"),
    ]
    for path in candidates:
        if not os.path.isfile(path):
            continue
        try:
            img = ImageReader(path)
            c.drawImage(img, x, y, width=w, height=h, preserveAspectRatio=True, mask="auto", anchor="sw")
            return
        except Exception:
            pass

    c.setFillColor(colors.white)
    c.setFont("Helvetica-Bold", 10)
    c.drawString(x + 3, y + (h * 0.4), "ARYNIK")


def _draw_qr(c: canvas.Canvas, value: str, x: float, y: float, size: float) -> None:
    payload = _ascii_text(value, max_len=120)
    widget = qr.QrCodeWidget(payload)
    bounds = widget.getBounds()
    w = bounds[2] - bounds[0]
    h = bounds[3] - bounds[1]
    if w <= 0 or h <= 0:
        return
    drawing = Drawing(size, size, transform=[size / w, 0, 0, size / h, 0, 0])
    drawing.add(widget)
    renderPDF.draw(drawing, c, x, y)


def _draw_code128(c: canvas.Canvas, value: str, *, x: float, y: float, width: float, height: float) -> None:
    payload = _ascii_text(value, fallback="AWB", max_len=64)
    barcode = code128.Code128(payload, barHeight=height, humanReadable=False)
    bw = float(getattr(barcode, "width", 0.0) or 0.0)
    if bw <= 0.01:
        return
    scale_x = max(0.5, min(1.7, width / bw))
    c.saveState()
    c.setFillColor(colors.black)
    c.setStrokeColor(colors.black)
    c.translate(x, y)
    c.scale(scale_x, 1.0)
    barcode.drawOn(c, 0, 0)
    c.restoreState()


def build_manual_label_payload(ship: models.Shipment) -> Dict[str, Any]:
    recipient_location = ship.recipient_location if isinstance(ship.recipient_location, dict) else {}
    sender_location = ship.sender_location if isinstance(ship.sender_location, dict) else {}

    county = _as_text(recipient_location.get("countyName") or recipient_location.get("county"), fallback="", max_len=70)
    locality = _as_text(getattr(ship, "locality", None), fallback="", max_len=70)
    locality_line = locality
    if county:
        locality_line = f"{locality}, {county}" if locality else county

    sender_name = _as_text(
        getattr(ship, "sender_shop_name", None)
        or sender_location.get("name")
        or sender_location.get("shopName"),
        fallback="ARYNIK HUB",
        max_len=120,
    )
    sender_address = _as_text(
        sender_location.get("addressText") or sender_location.get("address"),
        fallback="",
        max_len=140,
    )

    created_dt = getattr(ship, "created_date", None) or getattr(ship, "last_updated", None) or datetime.utcnow()

    return {
        "awb": _as_text(getattr(ship, "awb", None), max_len=64),
        "recipient_name": _as_text(getattr(ship, "recipient_name", None), max_len=70),
        "recipient_phone": _as_text(getattr(ship, "recipient_phone", None), fallback="-", max_len=40),
        "recipient_email": _as_text(getattr(ship, "recipient_email", None), fallback="", max_len=90),
        "delivery_address": _as_text(getattr(ship, "delivery_address", None), fallback="-", max_len=220),
        "locality_line": _as_text(locality_line, fallback="-", max_len=120),
        "cod_amount": float(getattr(ship, "cod_amount", 0.0) or 0.0),
        "weight": float(getattr(ship, "weight", 0.0) or 0.0),
        "parcels": max(1, int(getattr(ship, "number_of_parcels", 1) or 1)),
        "content_description": _as_text(getattr(ship, "content_description", None), fallback="General parcel", max_len=200),
        "created_at": created_dt.strftime("%Y-%m-%d %H:%M"),
        "currency": _as_text(getattr(ship, "currency", None), fallback="RON", max_len=8),
        "status": _as_text(getattr(ship, "status", None), fallback="In depozit", max_len=60),
        "sender_shop_name": sender_name,
        "sender_address": sender_address,
        "declared_value": float(getattr(ship, "declared_value", 0.0) or 0.0),
    }


def _generate_reportlab_manual_awb_label_pdf(
    *,
    awb: str,
    recipient_name: str,
    recipient_phone: str,
    recipient_email: str,
    delivery_address: str,
    locality_line: str,
    cod_amount: float,
    weight: float,
    parcels: int,
    content_description: str,
    created_at: str,
    currency: str = "RON",
    status: str = "In depozit",
    sender_shop_name: str = "ARYNIK HUB",
    sender_address: str = "",
    declared_value: float = 0.0,
    created_by: Optional[str] = None,
) -> bytes:
    out = io.BytesIO()
    c = canvas.Canvas(out, pagesize=(PAGE_W, PAGE_H))
    c.setTitle(f"ARYNIK_POSTIS_STYLE_{_ascii_text(awb, max_len=50)}")
    c.setAuthor("Curieru")
    c.setSubject("Manual shipment label")

    margin = 8.0
    x0 = margin
    y0 = margin
    w = PAGE_W - (margin * 2.0)
    h = PAGE_H - (margin * 2.0)

    # black main background (as in Postis sample).
    c.setFillColor(colors.black)
    c.rect(x0, y0, w, h, stroke=0, fill=1)

    # Top strip.
    top_h = 46.0
    top_y = y0 + h - top_h
    c.setFillColor(colors.white)
    c.rect(x0, top_y, w, top_h, stroke=0, fill=1)

    left_w = 106.0
    qr_w = 42.0
    right_w = 56.0
    c.setStrokeColor(colors.HexColor("#BFC3C8"))
    c.setLineWidth(1.0)
    c.line(x0 + left_w, top_y, x0 + left_w, top_y + top_h)
    c.line(x0 + left_w + qr_w, top_y, x0 + left_w + qr_w, top_y + top_h)
    c.line(x0 + w - right_w, top_y, x0 + w - right_w, top_y + top_h)

    # Logo on dark-blue tile.
    c.setFillColor(colors.HexColor("#0B2A63"))
    c.rect(x0 + 5, top_y + 5, left_w - 10, top_h - 10, stroke=0, fill=1)
    _draw_logo(c, x0 + 9, top_y + 9, left_w - 18, top_h - 18)

    # QR and piece counter.
    _draw_qr(c, f"AWB:{_ascii_text(awb, max_len=64)}", x0 + left_w + 4, top_y + 5, qr_w - 8)
    c.setFillColor(colors.black)
    c.setFont("Helvetica-Bold", 6.8)
    c.drawCentredString(x0 + left_w + (qr_w * 0.5), top_y + 2.2, "QR")

    c.setFillColor(colors.white)
    c.rect(x0 + w - right_w + 4, top_y + 5, right_w - 8, top_h - 10, stroke=0, fill=1)
    c.setFillColor(colors.black)
    c.setFont("Helvetica-Bold", 24)
    c.drawCentredString(x0 + w - (right_w * 0.5), top_y + 12, f"1 / {max(1, int(parcels))}")

    # AWB + mini summary on black band.
    awb_y = top_y - 54
    c.setFillColor(colors.white)
    c.setFont("Helvetica-Bold", 8)
    c.drawString(x0 + 6, awb_y + 40, "AWB")
    c.setFont("Helvetica-Bold", 21)
    c.drawString(x0 + 6, awb_y + 20, _ascii_text(awb, max_len=20))

    c.setFont("Helvetica-Bold", 7)
    c.drawString(x0 + 6, awb_y + 6, "Ramburs")
    c.drawString(x0 + 86, awb_y + 6, "Greutate")
    c.setFont("Helvetica-Bold", 18)
    c.drawString(x0 + 6, awb_y - 13, f"{float(cod_amount or 0.0):.0f} {currency}")
    c.drawString(x0 + 86, awb_y - 13, f"{float(weight or 0.0):.2f} KG")

    # Gray info block 1
    block1_y = awb_y - 104
    block1_h = 96
    c.setFillColor(colors.HexColor("#DCDCDC"))
    c.rect(x0, block1_y, w, block1_h, stroke=0, fill=1)
    left_col_w = 143.0
    c.setStrokeColor(colors.HexColor("#6B7280"))
    c.setLineWidth(0.7)
    c.line(x0 + left_col_w, block1_y, x0 + left_col_w, block1_y + block1_h)

    c.setFillColor(colors.black)
    c.setFont("Helvetica-Bold", 7)
    c.drawString(x0 + 6, block1_y + block1_h - 12, f"Ref: {_ascii_text(awb, max_len=24)}")
    c.drawString(x0 + 6, block1_y + block1_h - 26, "Interval Livr")
    c.setFont("Helvetica", 7)
    c.drawString(x0 + 62, block1_y + block1_h - 26, _ascii_text(status, max_len=24))

    c.setFont("Helvetica-Bold", 7)
    c.drawString(x0 + 6, block1_y + block1_h - 41, "Expeditor")
    c.setFont("Helvetica", 6.5)
    _draw_wrapped(
        c,
        f"{_ascii_text(sender_shop_name, max_len=78)} {_ascii_text(sender_address, fallback='', max_len=90)}".strip(),
        x0 + 6,
        block1_y + block1_h - 52,
        width=left_col_w - 12,
        font_name="Helvetica",
        font_size=6.4,
        max_lines=3,
        leading=7.3,
    )

    c.setFont("Helvetica-Bold", 7)
    c.drawString(x0 + 6, block1_y + 28, "Destinatar")
    c.setFont("Helvetica", 6.5)
    dest = f"{_ascii_text(recipient_name, max_len=70)} / {_ascii_text(recipient_phone, max_len=32)} / {_ascii_text(delivery_address, max_len=120)} / {_ascii_text(locality_line, max_len=70)}"
    _draw_wrapped(
        c,
        dest,
        x0 + 6,
        block1_y + 19,
        width=left_col_w - 12,
        font_name="Helvetica",
        font_size=6.3,
        max_lines=4,
        leading=6.9,
    )

    c.setFont("Helvetica-Bold", 7)
    c.drawString(x0 + left_col_w + 6, block1_y + block1_h - 12, "Continut")
    c.setFont("Helvetica", 6.5)
    _draw_wrapped(
        c,
        f"{_ascii_text(content_description, max_len=120)} / {_ascii_text(awb, max_len=24)}",
        x0 + left_col_w + 6,
        block1_y + block1_h - 23,
        width=w - left_col_w - 12,
        font_name="Helvetica",
        font_size=6.4,
        max_lines=3,
        leading=7.1,
    )
    c.setFont("Helvetica-Bold", 7)
    c.drawRightString(x0 + w - 6, block1_y + block1_h - 12, f"Pic: 0   Col: {max(1, int(parcels))}   Pal: 0")

    # Gray info block 2
    block2_y = block1_y - 52
    block2_h = 46
    c.setFillColor(colors.HexColor("#E5E7EB"))
    c.rect(x0, block2_y, w, block2_h, stroke=0, fill=1)
    c.setStrokeColor(colors.HexColor("#6B7280"))
    c.line(x0 + left_col_w, block2_y, x0 + left_col_w, block2_y + block2_h)

    c.setFillColor(colors.black)
    c.setFont("Helvetica-Bold", 7)
    c.drawString(x0 + 6, block2_y + block2_h - 12, "Optiuni")
    c.setFont("Helvetica", 6.5)
    c.drawString(x0 + 10, block2_y + block2_h - 24, "Liv.Sambata")
    c.drawString(x0 + 62, block2_y + block2_h - 24, "[ ]")
    c.drawString(x0 + 88, block2_y + block2_h - 24, "Deschidere")
    c.drawString(x0 + 137, block2_y + block2_h - 24, "[ ]")
    c.setFont("Helvetica-Bold", 7)
    c.drawString(x0 + 6, block2_y + 11, "Asigurare")
    c.setFont("Helvetica", 6.5)
    c.drawString(x0 + 56, block2_y + 11, f"{'[x]' if float(declared_value or 0.0) > 0 else '[ ]'}")
    c.drawString(x0 + 82, block2_y + 11, "Liv.Dimineata")
    c.drawString(x0 + 141, block2_y + 11, "[ ]")

    c.setFont("Helvetica-Bold", 7)
    c.drawString(x0 + left_col_w + 6, block2_y + block2_h - 12, "ARYNIK")
    c.setFont("Helvetica-Bold", 16)
    c.drawString(x0 + left_col_w + 6, block2_y + 10, "SWAP")

    # Big barcode zone at bottom.
    barcode_zone_h = 106
    barcode_zone_y = y0 + 8
    c.setFillColor(colors.black)
    c.rect(x0, barcode_zone_y, w, barcode_zone_h, stroke=0, fill=1)

    inner_w = w - 82
    inner_x = x0 + 41
    inner_y = barcode_zone_y + 10
    inner_h = 66
    c.setFillColor(colors.white)
    c.rect(inner_x, inner_y, inner_w, inner_h, stroke=0, fill=1)
    _draw_code128(c, _ascii_text(awb, max_len=48), x=inner_x + 6, y=inner_y + 9, width=inner_w - 12, height=45)

    c.setFillColor(colors.white)
    c.setFont("Helvetica-Bold", 7)
    c.drawCentredString(x0 + (w * 0.5), barcode_zone_y + 81, _ascii_text(awb, max_len=48))
    c.setFont("Helvetica", 6)
    footer_line = f"Created {created_at}"
    if created_by:
        footer_line += f" | Operator {created_by}"
    c.drawCentredString(x0 + (w * 0.5), barcode_zone_y + 1.5, _ascii_text(footer_line, max_len=90))

    c.showPage()
    c.save()
    return out.getvalue()


def _generate_fallback_text_pdf(*, awb: str, recipient_name: str, delivery_address: str) -> bytes:
    # Minimal fallback for environments without reportlab.
    text = (
        "%PDF-1.1\n"
        "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n"
        "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n"
        "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 288 432] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n"
        "4 0 obj << /Length 240 >> stream\n"
        "BT /F1 14 Tf 18 396 Td (ARYNIK POSTIS STYLE LABEL) Tj ET\n"
        f"BT /F1 11 Tf 18 360 Td (AWB: {_ascii_text(awb, max_len=52)}) Tj ET\n"
        f"BT /F1 10 Tf 18 334 Td (Recipient: {_ascii_text(recipient_name, max_len=72)}) Tj ET\n"
        f"BT /F1 10 Tf 18 314 Td (Address: {_ascii_text(delivery_address, max_len=120)}) Tj ET\n"
        "endstream endobj\n"
        "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n"
        "xref\n0 6\n"
        "0000000000 65535 f \n"
        "0000000010 00000 n \n"
        "0000000062 00000 n \n"
        "0000000120 00000 n \n"
        "0000000274 00000 n \n"
        "0000000590 00000 n \n"
        "trailer << /Root 1 0 R /Size 6 >>\n"
        "startxref\n660\n%%EOF\n"
    )
    return text.encode("latin-1", "ignore")


def generate_manual_awb_label_pdf(
    *,
    awb: str,
    recipient_name: str,
    recipient_phone: str,
    delivery_address: str,
    locality_line: str,
    cod_amount: float,
    weight: float,
    parcels: int,
    content_description: str,
    created_at: str,
    currency: str = "RON",
    status: str = "In depozit",
    sender_shop_name: str = "ARYNIK HUB",
    sender_address: str = "",
    recipient_email: str = "",
    declared_value: float = 0.0,
    created_by: Optional[str] = None,
) -> bytes:
    if REPORTLAB_AVAILABLE:
        return _generate_reportlab_manual_awb_label_pdf(
            awb=awb,
            recipient_name=recipient_name,
            recipient_phone=recipient_phone,
            recipient_email=recipient_email,
            delivery_address=delivery_address,
            locality_line=locality_line,
            cod_amount=cod_amount,
            weight=weight,
            parcels=parcels,
            content_description=content_description,
            created_at=created_at,
            currency=currency,
            status=status,
            sender_shop_name=sender_shop_name,
            sender_address=sender_address,
            declared_value=declared_value,
            created_by=created_by,
        )
    return _generate_fallback_text_pdf(awb=awb, recipient_name=recipient_name, delivery_address=delivery_address)


def generate_label_for_shipment(ship: models.Shipment, *, created_by: Optional[str] = None) -> bytes:
    payload = build_manual_label_payload(ship)
    return generate_manual_awb_label_pdf(
        awb=str(payload.get("awb") or "-"),
        recipient_name=str(payload.get("recipient_name") or "-"),
        recipient_phone=str(payload.get("recipient_phone") or "-"),
        recipient_email=str(payload.get("recipient_email") or ""),
        delivery_address=str(payload.get("delivery_address") or "-"),
        locality_line=str(payload.get("locality_line") or "-"),
        cod_amount=float(payload.get("cod_amount") or 0.0),
        weight=float(payload.get("weight") or 0.0),
        parcels=int(payload.get("parcels") or 1),
        content_description=str(payload.get("content_description") or "General parcel"),
        created_at=str(payload.get("created_at") or datetime.utcnow().strftime("%Y-%m-%d %H:%M")),
        currency=str(payload.get("currency") or "RON"),
        status=str(payload.get("status") or "In depozit"),
        sender_shop_name=str(payload.get("sender_shop_name") or "ARYNIK HUB"),
        sender_address=str(payload.get("sender_address") or ""),
        declared_value=float(payload.get("declared_value") or 0.0),
        created_by=created_by,
    )
