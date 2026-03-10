from __future__ import annotations

from typing import Any, Dict, List, Optional


VEHICLE_TYPE_PROFILES: List[Dict[str, Any]] = [
    {
        "code": "VAN_35T",
        "label": "3.5t Van",
        "description": "3.5t van (optionally with liftgate)",
        "supports_liftgate": True,
        "max_volume_m3": 18.0,
        "target_volume_m3": 16.5,
        "max_weight_kg": 1400.0,
        "target_weight_kg": 1200.0,
    },
    {
        "code": "TRUCK_75T",
        "label": "7.5t Truck",
        "description": "Medium truck",
        "supports_liftgate": True,
        "max_volume_m3": 36.0,
        "target_volume_m3": 33.0,
        "max_weight_kg": 3500.0,
        "target_weight_kg": 3200.0,
    },
    {
        "code": "TRUCK_12T",
        "label": "12t Truck",
        "description": "Large rigid truck",
        "supports_liftgate": True,
        "max_volume_m3": 50.0,
        "target_volume_m3": 46.0,
        "max_weight_kg": 7000.0,
        "target_weight_kg": 6500.0,
    },
    {
        "code": "TIR_40T",
        "label": "TIR 40t",
        "description": "Articulated truck / trailer",
        "supports_liftgate": False,
        "max_volume_m3": 90.0,
        "target_volume_m3": 82.0,
        "max_weight_kg": 24000.0,
        "target_weight_kg": 22000.0,
    },
    {
        "code": "SPRINTER",
        "label": "Sprinter",
        "description": "Small van",
        "supports_liftgate": False,
        "max_volume_m3": 13.0,
        "target_volume_m3": 11.5,
        "max_weight_kg": 900.0,
        "target_weight_kg": 800.0,
    },
    {
        "code": "CUSTOM",
        "label": "Custom",
        "description": "Custom capacities",
        "supports_liftgate": True,
        "max_volume_m3": None,
        "target_volume_m3": None,
        "max_weight_kg": None,
        "target_weight_kg": None,
    },
]


_PROFILES_BY_CODE: Dict[str, Dict[str, Any]] = {
    str(p.get("code") or "").strip().upper(): p for p in VEHICLE_TYPE_PROFILES
}


def normalize_vehicle_type_code(value: Optional[str]) -> Optional[str]:
    code = str(value or "").strip().upper()
    if not code:
        return None
    if code in _PROFILES_BY_CODE:
        return code
    return None


def list_vehicle_types() -> List[Dict[str, Any]]:
    return [dict(profile) for profile in VEHICLE_TYPE_PROFILES]


def get_vehicle_type_profile(code: Optional[str]) -> Optional[Dict[str, Any]]:
    key = normalize_vehicle_type_code(code)
    if not key:
        return None
    src = _PROFILES_BY_CODE.get(key)
    return dict(src) if src else None


def defaults_for_type(code: Optional[str]) -> Dict[str, Optional[float]]:
    profile = get_vehicle_type_profile(code)
    if not profile:
        return {
            "max_volume_m3": None,
            "target_volume_m3": None,
            "max_weight_kg": None,
            "target_weight_kg": None,
        }
    return {
        "max_volume_m3": _to_float(profile.get("max_volume_m3")),
        "target_volume_m3": _to_float(profile.get("target_volume_m3")),
        "max_weight_kg": _to_float(profile.get("max_weight_kg")),
        "target_weight_kg": _to_float(profile.get("target_weight_kg")),
    }


def _to_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        n = float(value)
    except Exception:
        return None
    if n <= 0:
        return None
    return n
