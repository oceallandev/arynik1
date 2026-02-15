"""
Canonical Postis shipment status options (eventId -> eventDescription).

These strings must match Postis exactly, because they are sent back in the
`eventDescription` field when calling the status update endpoints.
"""

from __future__ import annotations

from typing import Dict, List


STATUS_OPTIONS: List[dict] = [
    {"event_id": "1", "label": "Expediere preluata de Curier", "description": "Expediere preluata de Curier"},
    {"event_id": "2", "label": "Expeditie Livrata", "description": "Expeditie Livrata"},
    {"event_id": "3", "label": "Refuzare colet", "description": "Refuzare colet"},
    {"event_id": "4", "label": "Expeditie returnata", "description": "Expeditie returnata"},
    {"event_id": "5", "label": "Expeditie anulata", "description": "Expeditie anulata"},
    {"event_id": "6", "label": "Intrare in depozit", "description": "Intrare in depozit"},
    {"event_id": "7", "label": "Livrare reprogramata", "description": "Livrare reprogramata"},
    {"event_id": "R3", "label": "Ramburs transferat", "description": "Ramburs transferat"},
]


def event_id_to_description() -> Dict[str, str]:
    return {opt["event_id"]: opt["label"] for opt in STATUS_OPTIONS}

