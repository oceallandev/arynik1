"""
Canonical Postis shipment status options (eventId -> eventDescription).

These strings must match Postis exactly, because they are sent back in the
`eventDescription` field when calling the status update endpoints.
"""

from __future__ import annotations

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


def event_id_to_description() -> Dict[str, str]:
    return {opt["event_id"]: opt["label"] for opt in STATUS_OPTIONS}
