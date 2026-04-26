from __future__ import annotations

from datetime import datetime
import re
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
        models.ManifestScanCache.__table__.create(bind=db.get_bind(), checkfirst=True)
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
        len(scanned) >= 8
        and scanned[-3:].isdigit()
        and scanned[-3:] != "000"
    ):
        core_candidate = scanned[:-3]
        if len(core_candidate) >= 5:
            core = core_candidate
            try:
                parcel_idx = int(scanned[-3:])
            except Exception:
                parcel_idx = None

    return core, parcel_idx, scanned


def _candidate_awb_cores_from_scanned(scanned: str) -> List[str]:
    base = postis_client.normalize_shipment_identifier(scanned)
    if not base:
        return []

    out: List[str] = []
    for cand in postis_client.candidates_with_optional_parcel_suffix_stripped(base):
        key = postis_client.normalize_shipment_identifier(cand)
        if key and key not in out:
            out.append(key)

    # Some scanners emit 6-digit parcel suffixes (e.g. ...654001).
    if len(base) >= 15 and any("A" <= ch <= "Z" for ch in base) and re.match(r"^\d{6}$", base[-6:]):
        core6 = base[:-6]
        if len(core6) >= 8 and core6 not in out:
            out.append(core6)

    return out[:20]


def resolve_scanned_awb(
    db: Session,
    *,
    identifier: str,
    manifest_id: Optional[int] = None,
) -> Tuple[str, Optional[int], str, str]:
    scanned = postis_client.normalize_shipment_identifier(identifier)
    if not scanned:
        return "", None, "", "invalid"

    def parcel_idx_for_resolved(resolved_awb: str) -> Optional[int]:
        resolved_key = postis_client.normalize_shipment_identifier(resolved_awb)
        if not resolved_key or resolved_key == scanned:
            return None
        suffix = ""
        if scanned[:-3] == resolved_key and scanned[-3:].isdigit() and scanned[-3:] != "000":
            suffix = scanned[-3:]
        elif scanned[:-6] == resolved_key and scanned[-3:].isdigit() and scanned[-3:] != "000":
            suffix = scanned[-3:]
        if not suffix:
            return None
        try:
            return int(suffix)
        except Exception:
            return None

    cache = (
        db.query(models.ManifestScanCache)
        .filter(models.ManifestScanCache.normalized_identifier == scanned)
        .first()
    )
    if cache and str(getattr(cache, "resolved_awb", "") or "").strip():
        resolved = str(getattr(cache, "resolved_awb", "") or "").strip().upper()
        cache.updated_at = datetime.utcnow()
        if manifest_id is not None:
            cache.manifest_id = int(manifest_id)
        cache.scanned_identifier = str(identifier or "").strip() or scanned
        cache.resolution_source = "cache_hit"
        parcel_idx = parcel_idx_for_resolved(resolved)
        return resolved, parcel_idx, scanned, "cache_hit"

    candidates = _candidate_awb_cores_from_scanned(scanned)
    existing_awbs: set[str] = set()
    if candidates:
        rows = db.query(models.Shipment.awb).filter(models.Shipment.awb.in_(candidates)).all()
        for row in (rows or []):
            value = getattr(row, "awb", None)
            if value is None:
                try:
                    value = row[0]
                except Exception:
                    value = None
            key = str(value or "").strip().upper()
            if key:
                existing_awbs.add(key)

    resolved = ""
    source = "fallback"
    for cand in candidates:
        key = str(cand or "").strip().upper()
        if key in existing_awbs:
            resolved = key
            source = "exact" if key == scanned else ("suffix3" if key == scanned[:-3] else "suffix6")
            break

    if not resolved:
        fallback = ""
        for cand in candidates:
            key = str(cand or "").strip().upper()
            if key != scanned and len(key) >= 8:
                fallback = key
                break
        resolved = str((fallback or (candidates[0] if candidates else scanned)) or "").strip().upper()
        if resolved == scanned:
            source = "exact"
        elif resolved == scanned[:-3]:
            source = "suffix3"
        elif resolved == scanned[:-6]:
            source = "suffix6"

    parcel_idx = parcel_idx_for_resolved(resolved)
    payload = {
        "candidates": candidates,
        "parcel_idx": parcel_idx,
    }
    if cache:
        cache.updated_at = datetime.utcnow()
        cache.manifest_id = int(manifest_id) if manifest_id is not None else cache.manifest_id
        cache.scanned_identifier = str(identifier or "").strip() or scanned
        cache.resolved_awb = resolved
        cache.resolution_source = source
        cache.data = payload
    else:
        db.add(
            models.ManifestScanCache(
                manifest_id=int(manifest_id) if manifest_id is not None else None,
                scanned_identifier=str(identifier or "").strip() or scanned,
                normalized_identifier=scanned,
                resolved_awb=resolved,
                resolution_source=source,
                data=payload,
            )
        )
        db.flush()

    return resolved, parcel_idx, scanned, source


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

    core, parcel_idx, scanned, _source = resolve_scanned_awb(
        db,
        identifier=identifier,
        manifest_id=int(getattr(manifest, "id", 0) or 0) or None,
    )
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
