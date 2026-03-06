"""
Canonical Postis shipment status options (eventId -> eventDescription).

These strings must match Postis exactly, because they are sent back in the
`eventDescription` field when calling the status update endpoints.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Dict, List


STATUS_OPTIONS: List[dict] = [
    {"event_id": "1", "label": "Expediere preluata de Curier", "description": "Expediere preluata de Curier", "requirements": ["gps"]},
    # POD (proof-of-delivery) requirements are captured in the driver app payload and stored in our logs.
    {"event_id": "2", "label": "Expeditie Livrata", "description": "Expeditie Livrata", "requirements": ["gps", "photo", "signature", "cod_collect"]},
    {"event_id": "3", "label": "Refuzare colet", "description": "Refuzare colet", "requirements": ["gps", "reason", "photo"]},
    {"event_id": "4", "label": "Expeditie returnata", "description": "Expeditie returnata", "requirements": ["gps", "reason"]},
    {"event_id": "5", "label": "Expeditie anulata", "description": "Expeditie anulata", "requirements": ["reason"]},
    {"event_id": "6", "label": "Intrare in depozit", "description": "Intrare in depozit", "requirements": ["gps"]},
    {"event_id": "7", "label": "Livrare reprogramata", "description": "Livrare reprogramata", "requirements": ["reason", "reschedule_at"]},
    {"event_id": "R3", "label": "Ramburs transferat", "description": "Ramburs transferat", "requirements": ["cod_transfer"]},
]

INVALID_STATUS_LABELS = {
    "bc93ary 0746984168",
}


def _fold_status_text(value: object) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    normalized = unicodedata.normalize("NFD", text)
    without_marks = "".join(ch for ch in normalized if unicodedata.category(ch) != "Mn")
    return re.sub(r"\s+", " ", without_marks).strip().lower()


def _looks_like_noise_status(value: str) -> bool:
    # Known bad payload shape received from Postis side (code + phone/number).
    # Example: "BC93ARY 0746984168"
    if not value:
        return False
    return bool(re.match(r"^[a-z0-9]{5,}\s+[0-9]{6,}$", value))


def normalize_shipment_status(value: object) -> str:
    """
    Normalize status text coming from Postis payloads or DB rows.
    Keeps the display labels close to Postis naming and blocks known invalid noise.
    """
    raw = str(value or "").strip()
    folded = _fold_status_text(raw)
    if not folded:
        return "Finalizare pregatire depozit"

    if folded in INVALID_STATUS_LABELS or _looks_like_noise_status(folded):
        return "Status update from Driver App"

    if folded in ("pending", "initial", "in asteptare", "active", "new"):
        return "Finalizare pregatire depozit"
    if folded in ("in transit", "in_transit", "in tranzit", "in_tranzit"):
        return "Expediere preluata de Curier"
    if folded in ("livrat", "delivered"):
        return "Livrat"
    if folded in ("refuzat", "refused"):
        return "Refuzare colet"

    if "finalizare pregatire depozit" in folded:
        return "Finalizare pregatire depozit"
    if "expedierea a fost preluata de curier" in folded:
        return "Expedierea a fost preluata de curier"
    if "expediere preluata de curier" in folded:
        return "Expediere preluata de Curier"
    if "intrare in depozit" in folded or "in depozitul curierului" in folded or "courier warehouse" in folded or "in depot" in folded:
        return "Intrare in depozit"
    if "expeditie anulata" in folded or "anulata" in folded or "cancel" in folded:
        return "Expeditie anulata"
    if "refuzare colet" in folded or "livrare refuzata" in folded or "refuz" in folded:
        return "Refuzare colet"
    if "ramburs transferat" in folded:
        return "Ramburs transferat"
    if "expeditie livrata" in folded:
        return "Expeditie Livrata"
    if "livrare reprogramata" in folded or "reschedule" in folded:
        return "Livrare reprogramata"
    if "expeditie returnata" in folded or "returnata" in folded or "returned" in folded:
        return "Expeditie returnata"
    if "status update from driver app" in folded:
        return "Status update from Driver App"

    return raw


def event_id_to_description() -> Dict[str, str]:
    return {opt["event_id"]: opt["label"] for opt in STATUS_OPTIONS}
