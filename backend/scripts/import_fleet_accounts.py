from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple
import os
import sys

from sqlalchemy.orm import Session

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from backend import driver_manager, models
from backend.database import SessionLocal
from backend.services import drivers_service, phone_service, vehicle_types_service


@dataclass
class PersonSpec:
    name: str
    role: str
    plate: Optional[str] = None
    phone: Optional[str] = None
    helper_name: Optional[str] = None
    vehicle_type_code: Optional[str] = None
    vehicle_has_lift: Optional[bool] = None


STANDARD_ROWS: List[Dict[str, Optional[str]]] = [
    {
        "phone": "0792621163",
        "driver": "Borca Marius",
        "plate": "BC76ARI",
        "helper": "Mereuta Marius",
        "tir_plate": "BC29NIC",
        "tir_driver": "Pletosu Florinel",
    },
    {
        "phone": "0753670469",
        "driver": "Cercel Dorina",
        "plate": "BC09NYC",
        "helper": "Albut Costica",
        "tir_plate": "CJ66ANS",
        "tir_driver": "Macsim Florin",
    },
    {
        "phone": "0757717545",
        "driver": "Cozma Dragos",
        "plate": "BC93ARY",
        "helper": "Grozavescu Victor",
        "tir_plate": None,
        "tir_driver": "Surdu Gheorghe",
    },
    {
        "phone": "0755201704",
        "driver": "Incarca Catalin",
        "plate": "BC55NIK",
        "helper": "Tiu Ioan",
        "tir_plate": None,
        "tir_driver": None,
    },
    {
        "phone": "0754267757",
        "driver": "Lupu Florin",
        "plate": "BC91ARY",
        "helper": "Varga Ilie",
        "tir_plate": None,
        "tir_driver": None,
    },
    {
        "phone": "0741611414",
        "driver": "Simion Cristian",
        "plate": "BC01NIK",
        "helper": "Bour Ionica",
        "tir_plate": None,
        "tir_driver": None,
    },
    {
        "phone": "0759582813",
        "driver": "Costea Vasile",
        "plate": "BC75ARI",
        "helper": "Moraru Marian",
        "tir_plate": None,
        "tir_driver": None,
    },
    {
        "phone": None,
        "driver": "Lupu Florin Stefan",
        "plate": None,
        "helper": None,
        "tir_plate": None,
        "tir_driver": None,
    },
]


def _norm_text(value: Optional[str]) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    folded = unicodedata.normalize("NFD", text)
    folded = "".join(ch for ch in folded if unicodedata.category(ch) != "Mn")
    return re.sub(r"\s+", " ", folded).strip().casefold()


def _slug(value: str) -> str:
    folded = unicodedata.normalize("NFD", str(value or ""))
    folded = "".join(ch for ch in folded if unicodedata.category(ch) != "Mn")
    folded = re.sub(r"[^a-zA-Z0-9]+", "", folded).strip().lower()
    return folded or "user"


def _build_password(name: str) -> str:
    return f"{_slug(name)}123"


def _unique_username(db: Session, base: str, current_driver_id: Optional[str] = None) -> str:
    seed = _slug(base)
    candidate = seed
    idx = 2
    while True:
        q = db.query(models.Driver).filter(models.Driver.username == candidate)
        row = q.first()
        if not row:
            return candidate
        if current_driver_id and str(row.driver_id or "") == str(current_driver_id):
            return candidate
        candidate = f"{seed}{idx}"
        idx += 1


def _next_driver_id(db: Session, prefix: str) -> str:
    p = str(prefix or "USR").upper()
    idx = 1
    while True:
        did = f"{p}{idx:03d}"
        if not db.query(models.Driver).filter(models.Driver.driver_id == did).first():
            return did
        idx += 1


def _find_by_name(db: Session, name: str) -> Optional[models.Driver]:
    target = _norm_text(name)
    if not target:
        return None
    for row in db.query(models.Driver).all():
        if _norm_text(row.name) == target:
            return row
    return None


def _apply_vehicle_defaults(spec: PersonSpec) -> Tuple[Optional[float], Optional[float], Optional[float], Optional[float]]:
    defaults = vehicle_types_service.defaults_for_type(spec.vehicle_type_code)
    return (
        defaults.get("max_volume_m3"),
        defaults.get("target_volume_m3"),
        defaults.get("max_weight_kg"),
        defaults.get("target_weight_kg"),
    )


def _upsert_person(
    db: Session,
    spec: PersonSpec,
    prefix: str,
    *,
    reset_password: bool,
) -> Dict[str, str]:
    existing = _find_by_name(db, spec.name)

    password_plain = _build_password(spec.name)

    if existing:
        user = existing
    else:
        user = models.Driver(
            driver_id=_next_driver_id(db, prefix),
            active=True,
        )
        db.add(user)

    # Keep all fleet usernames human-readable and deterministic (based on full name),
    # while still ensuring uniqueness.
    username = _unique_username(db, spec.name, getattr(existing, "driver_id", None))

    vehicle_code = vehicle_types_service.normalize_vehicle_type_code(spec.vehicle_type_code)
    max_vol, target_vol, max_kg, target_kg = _apply_vehicle_defaults(spec)

    user.name = spec.name
    user.username = username
    if (not existing) or reset_password or not str(getattr(user, "password_hash", "") or "").strip():
        user.password_hash = driver_manager.get_password_hash(password_plain)
    user.role = spec.role
    user.active = True
    user.truck_plate = (str(spec.plate or "").strip().upper() or None)
    user.phone_number = (str(spec.phone or "").strip() or None)
    user.phone_norm = phone_service.normalize_phone(user.phone_number) if user.phone_number else None
    user.helper_name = (str(spec.helper_name or "").strip() or None)
    user.vehicle_type_code = vehicle_code
    user.vehicle_has_lift = bool(spec.vehicle_has_lift) if spec.vehicle_has_lift is not None else False if vehicle_code else None
    user.max_volume_m3 = max_vol
    user.target_volume_m3 = target_vol
    user.max_weight_kg = max_kg
    user.target_weight_kg = target_kg
    db.flush()

    return {
        "driver_id": str(user.driver_id or ""),
        "name": spec.name,
        "username": username,
        "password": password_plain if ((not existing) or reset_password) else "(unchanged)",
        "role": spec.role,
        "truck_plate": str(user.truck_plate or ""),
        "phone": str(user.phone_number or ""),
        "vehicle_type": str(user.vehicle_type_code or ""),
    }


def build_specs() -> List[Tuple[PersonSpec, str]]:
    out: List[Tuple[PersonSpec, str]] = []
    helpers_seen = set()
    tir_seen = set()

    for row in STANDARD_ROWS:
        driver_name = str(row.get("driver") or "").strip()
        if driver_name:
            out.append((
                PersonSpec(
                    name=driver_name,
                    role="Driver",
                    plate=row.get("plate"),
                    phone=row.get("phone"),
                    helper_name=row.get("helper"),
                    vehicle_type_code="VAN_35T",
                    vehicle_has_lift=False,
                ),
                "DRV",
            ))

        helper_name = str(row.get("helper") or "").strip()
        helper_key = _norm_text(helper_name)
        if helper_name and helper_key not in helpers_seen:
            helpers_seen.add(helper_key)
            out.append((
                PersonSpec(
                    name=helper_name,
                    role="Warehouse",
                    vehicle_type_code=None,
                ),
                "HLP",
            ))

        tir_driver = str(row.get("tir_driver") or "").strip()
        tir_key = _norm_text(tir_driver)
        if tir_driver and tir_key not in tir_seen:
            tir_seen.add(tir_key)
            out.append((
                PersonSpec(
                    name=tir_driver,
                    role="Driver",
                    plate=row.get("tir_plate"),
                    vehicle_type_code="TIR_40T",
                    vehicle_has_lift=False,
                ),
                "TIR",
            ))

    return out


def upsert_standard_fleet_accounts(
    db: Session,
    *,
    reset_passwords: bool = False,
) -> List[Dict[str, str]]:
    drivers_service.ensure_drivers_schema(db)
    specs = build_specs()
    results: List[Dict[str, str]] = []
    for spec, prefix in specs:
        results.append(
            _upsert_person(
                db,
                spec,
                prefix,
                reset_password=bool(reset_passwords),
            )
        )
    return results


def main() -> None:
    specs = build_specs()

    db = SessionLocal()
    try:
        results = []
        for spec, prefix in specs:
            results.append(_upsert_person(db, spec, prefix, reset_password=True))
        db.commit()

        print("Imported/updated accounts:")
        for row in results:
            print(
                "{driver_id}\t{name}\t{username}\t{password}\t{role}\t{truck_plate}\t{phone}\t{vehicle_type}".format(
                    **row
                )
            )
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


if __name__ == "__main__":
    main()
