from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

try:
    from .. import models, postis_client
except ImportError:  # pragma: no cover
    import models  # type: ignore
    import postis_client  # type: ignore


def ensure_manifests_schema(db: Session) -> bool:
    """
    Create manifest tables if missing.
    """
    try:
        models.Manifest.__table__.create(bind=db.get_bind(), checkfirst=True)
        models.ManifestItem.__table__.create(bind=db.get_bind(), checkfirst=True)
        return True
    except Exception:
        return False


def parse_scanned_identifier(value: str) -> Tuple[str, Optional[int], str]:
    """
    Parse a scanned barcode into:
    - core AWB identifier
    - optional parcel index (1..999) when the scan includes a 3-digit suffix
    - normalized scanned identifier
    """
    scanned = postis_client.normalize_shipment_identifier(value)
    if not scanned:
        return "", None, ""

    # Parcel labels sometimes contain AWB + 3-digit parcel suffix (001, 002...).
    # We use the same heuristic as postis_client.candidates_with_optional_parcel_suffix_stripped.
    parcel_idx: Optional[int] = None
    core = scanned
    if (
        len(scanned) >= 13
        and any("A" <= ch <= "Z" for ch in scanned)
        and scanned[-3:].isdigit()
        and scanned[-3:] != "000"
    ):
        core_candidate = scanned[:-3]
        if len(core_candidate) >= 8:
            core = core_candidate
            try:
                parcel_idx = int(scanned[-3:])
            except Exception:
                parcel_idx = None

    return core, parcel_idx, scanned


def create_manifest(
    db: Session,
    *,
    created_by_user_id: str,
    created_by_role: Optional[str],
    truck_plate: Optional[str],
    date: Optional[str],
    kind: str = "loadout",
    notes: Optional[str] = None,
) -> Optional[models.Manifest]:
    if not ensure_manifests_schema(db):
        return None

    m = models.Manifest(
        created_at=datetime.utcnow(),
        created_by_user_id=str(created_by_user_id or "").strip(),
        created_by_role=(str(created_by_role or "").strip() or None),
        truck_plate=(str(truck_plate or "").strip().upper() or None),
        date=(str(date or "").strip() or None),
        kind=(str(kind or "loadout").strip().lower() or "loadout"),
        status="Open",
        notes=(str(notes or "").strip() or None),
    )
    db.add(m)
    return m


def get_manifest(db: Session, manifest_id: int) -> Optional[models.Manifest]:
    if not ensure_manifests_schema(db):
        return None
    try:
        mid = int(manifest_id)
    except Exception:
        return None
    return db.query(models.Manifest).filter(models.Manifest.id == mid).first()


def list_manifests(db: Session, *, limit: int = 50) -> List[models.Manifest]:
    if not ensure_manifests_schema(db):
        return []
    try:
        limit_n = int(limit or 50)
    except Exception:
        limit_n = 50
    limit_n = max(1, min(limit_n, 200))
    return (
        db.query(models.Manifest)
        .order_by(models.Manifest.created_at.desc())
        .limit(limit_n)
        .all()
    )


def _as_list(value: Any) -> List[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return []


def scan_into_manifest(
    db: Session,
    *,
    manifest: models.Manifest,
    identifier: str,
    scanned_by_user_id: str,
    parcels_total: Optional[int] = None,
    data: Optional[Dict[str, Any]] = None,
) -> Optional[models.ManifestItem]:
    if not manifest or not identifier:
        return None
    if str(manifest.status or "").strip().lower() != "open":
        return None

    core, parcel_idx, scanned = parse_scanned_identifier(identifier)
    if not core:
        return None

    item = (
        db.query(models.ManifestItem)
        .filter(models.ManifestItem.manifest_id == manifest.id, models.ManifestItem.awb == core)
        .first()
    )
    now = datetime.utcnow()

    if not item:
        item = models.ManifestItem(
            manifest_id=manifest.id,
            awb=core,
            parcels_total=None,
            scanned_identifiers=[],
            scanned_parcel_indexes=[],
            scan_count=0,
            last_scanned_at=None,
            last_scanned_by=None,
            data=None,
        )
        db.add(item)
        db.flush()

    scanned_identifiers = [str(x) for x in _as_list(getattr(item, "scanned_identifiers", None)) if x]
    scanned_parcels = [int(x) for x in _as_list(getattr(item, "scanned_parcel_indexes", None)) if isinstance(x, int) or (isinstance(x, str) and str(x).isdigit())]
    scanned_parcels_set = set(scanned_parcels)

    # Always record the scan (keep a bounded list to avoid unbounded growth).
    if scanned and scanned not in scanned_identifiers:
        scanned_identifiers.append(scanned)
        if len(scanned_identifiers) > 2000:
            scanned_identifiers = scanned_identifiers[-2000:]

    if parcel_idx is not None and parcel_idx > 0:
        scanned_parcels_set.add(int(parcel_idx))

    item.scanned_identifiers = scanned_identifiers
    item.scanned_parcel_indexes = sorted(scanned_parcels_set) if scanned_parcels_set else []
    item.scan_count = int(item.scan_count or 0) + 1
    item.last_scanned_at = now
    item.last_scanned_by = str(scanned_by_user_id or "").strip() or None

    if parcels_total is not None:
        try:
            pt = int(parcels_total)
        except Exception:
            pt = None
        if pt is not None and pt > 0:
            item.parcels_total = pt

    if data:
        item.data = data

    return item


def close_manifest(db: Session, *, manifest: models.Manifest, notes: Optional[str] = None) -> Optional[models.Manifest]:
    if not manifest:
        return None
    manifest.status = "Closed"
    if notes is not None:
        manifest.notes = str(notes or "").strip() or None
    return manifest

