from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
import logging
import os
import random
import time
from typing import Any, Dict, List, Optional, Tuple

try:
    from .. import database, models, postis_client
except ImportError:  # pragma: no cover
    import database, models, postis_client  # type: ignore

try:
    from . import shipments_service
except ImportError:  # pragma: no cover
    import shipments_service  # type: ignore


logger = logging.getLogger(__name__)

_TRUTHY = {"1", "true", "yes", "y", "on"}
_FALSY = {"0", "false", "no", "n", "off", ""}


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    val = str(raw).strip().lower()
    if val in _TRUTHY:
        return True
    if val in _FALSY:
        return False
    return default


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return int(str(raw).strip())
    except Exception:
        return default


def _parse_dt(value: Any) -> Optional[datetime]:
    """Parse Postis timestamps into naive UTC datetimes (compatible with our DB fields)."""
    if not value:
        return None
    if isinstance(value, datetime):
        dt = value
    else:
        s = str(value).strip()
        if not s:
            return None
        try:
            if s.endswith("Z"):
                s = s[:-1] + "+00:00"
            dt = datetime.fromisoformat(s)
        except Exception:
            return None

    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def _normalize_status(ship_data: Dict[str, Any]) -> str:
    raw = (
        ship_data.get("clientShipmentStatusDescription")
        or ship_data.get("processingStatus")
        or ship_data.get("status")
        or ship_data.get("currentStatus")
        or ship_data.get("defaultClientStatus")
    )

    text_val = str(raw).strip() if raw is not None else ""
    lower = text_val.strip().lower()

    if lower in ("livrat", "delivered"):
        return "Delivered"
    if lower in ("initial", "routed", "in transit", "in_transit", "in tranzit", "in_tranzit"):
        return "In Transit"
    if lower in ("refuzat", "refused"):
        return "Refused"

    return text_val or "pending"


def _extract_awb(ship_data: Dict[str, Any]) -> Optional[str]:
    awb = ship_data.get("awb") or ship_data.get("AWB") or ship_data.get("trackingNumber")
    awb = postis_client.normalize_shipment_identifier(awb) if awb is not None else ""
    return awb or None


@dataclass(frozen=True)
class PostisSyncConfig:
    enabled: bool
    interval_seconds: int
    page_size: int
    concurrency: int
    max_awbs_per_run: Optional[int]
    include_missing_raw: bool
    startup_jitter_seconds: int
    run_immediately: bool


def load_config_from_env() -> PostisSyncConfig:
    enabled = _env_bool("AUTO_SYNC_POSTIS", default=False)
    interval_seconds = max(300, _env_int("AUTO_SYNC_POSTIS_INTERVAL_SECONDS", 3600))
    page_size = max(10, min(_env_int("AUTO_SYNC_POSTIS_PAGE_SIZE", 100), 500))
    concurrency = max(1, min(_env_int("AUTO_SYNC_POSTIS_CONCURRENCY", 6), 30))

    max_awbs_raw = os.getenv("AUTO_SYNC_POSTIS_MAX_AWBS_PER_RUN")
    max_awbs_per_run: Optional[int]
    if max_awbs_raw is None or not str(max_awbs_raw).strip():
        max_awbs_per_run = None
    else:
        try:
            max_awbs_per_run = int(str(max_awbs_raw).strip())
        except Exception:
            max_awbs_per_run = None
    if max_awbs_per_run is not None and max_awbs_per_run <= 0:
        max_awbs_per_run = None

    include_missing_raw = _env_bool("AUTO_SYNC_POSTIS_INCLUDE_MISSING_RAW", default=True)
    startup_jitter_seconds = max(0, min(_env_int("AUTO_SYNC_POSTIS_STARTUP_JITTER_SECONDS", 30), 600))
    run_immediately = _env_bool("AUTO_SYNC_POSTIS_RUN_IMMEDIATELY", default=True)

    return PostisSyncConfig(
        enabled=enabled,
        interval_seconds=interval_seconds,
        page_size=page_size,
        concurrency=concurrency,
        max_awbs_per_run=max_awbs_per_run,
        include_missing_raw=include_missing_raw,
        startup_jitter_seconds=startup_jitter_seconds,
        run_immediately=run_immediately,
    )


@dataclass
class PostisSyncStats:
    started_at: datetime
    finished_at: datetime
    list_items: int
    unique_awbs: int
    new_awbs: int
    changed_awbs: int
    fetched_details: int
    upserted: int
    fetch_errors: int
    upsert_errors: int


def _db_select_changed_awbs(
    remote_state: Dict[str, Tuple[Optional[datetime], str, Optional[str]]],
    *,
    max_awbs_per_run: Optional[int],
    include_missing_raw: bool,
) -> Tuple[List[str], int]:
    """
    Return (changed_awbs, new_awbs_count) based on comparing v3 list metadata against DB.

    NOTE: Runs in a thread (sync SQLAlchemy).
    """
    db = database.SessionLocal()
    try:
        shipments_service.ensure_shipments_schema(db)

        existing: Dict[str, Tuple[Optional[str], Optional[datetime], Optional[str]]] = {}
        for awb, status, awb_dt, processing_status in (
            db.query(
                models.Shipment.awb,
                models.Shipment.status,
                models.Shipment.awb_status_date,
                models.Shipment.processing_status,
            ).all()
        ):
            key = postis_client.normalize_shipment_identifier(awb) if awb is not None else ""
            if not key:
                continue
            existing[key] = (
                str(status).strip() if status is not None else None,
                awb_dt,
                str(processing_status).strip() if processing_status is not None else None,
            )

        missing_raw: set[str] = set()
        if include_missing_raw:
            try:
                rows = db.query(models.Shipment.awb).filter(models.Shipment.raw_data.is_(None)).all()
                missing_raw = {
                    postis_client.normalize_shipment_identifier(r[0]) for r in rows if r and r[0] is not None
                }
                missing_raw.discard("")
            except Exception:
                missing_raw = set()

        changed: List[str] = []
        new_count = 0

        for awb, (remote_dt, remote_status, remote_proc) in remote_state.items():
            ex = existing.get(awb)
            if ex is None:
                new_count += 1
                changed.append(awb)
                continue

            if awb in missing_raw:
                changed.append(awb)
                continue

            ex_status, ex_dt, ex_proc = ex

            if remote_dt is not None:
                if ex_dt is None or remote_dt > ex_dt:
                    changed.append(awb)
                    continue

            rs = str(remote_status or "").strip()
            if rs:
                es = str(ex_status or "").strip()
                if not es or es.casefold() != rs.casefold():
                    changed.append(awb)
                    continue

            rp = str(remote_proc or "").strip()
            if rp:
                ep = str(ex_proc or "").strip()
                if not ep or ep.casefold() != rp.casefold():
                    changed.append(awb)
                    continue

        if max_awbs_per_run is not None and len(changed) > max_awbs_per_run:
            # Prefer refreshing recently updated shipments first (falls back to stable AWB sort).
            changed.sort(
                key=lambda a: (
                    remote_state.get(a, (None, "", None))[0] is not None,
                    remote_state.get(a, (None, "", None))[0] or datetime.min,
                    a,
                ),
                reverse=True,
            )
            changed = changed[:max_awbs_per_run]

        return changed, new_count
    finally:
        db.close()


def _db_apply_postis_payloads(payloads: List[Dict[str, Any]], *, commit_every: int = 50) -> Tuple[int, int]:
    """
    Apply Postis shipment payloads into the DB.

    Returns (upserted_count, error_count).
    NOTE: Runs in a thread (sync SQLAlchemy).
    """
    if not payloads:
        return 0, 0

    db = database.SessionLocal()
    try:
        shipments_service.ensure_shipments_schema(db)
        upserted = 0
        errors = 0

        for idx, ship_data in enumerate(payloads, 1):
            try:
                shipments_service.upsert_shipment_and_events(db, ship_data)
                upserted += 1
                if commit_every > 0 and idx % commit_every == 0:
                    db.commit()
            except Exception:
                errors += 1
                db.rollback()

        db.commit()
        return upserted, errors
    finally:
        db.close()


async def _fetch_all_shipments_v3(
    client: postis_client.PostisClient,
    *,
    page_size: int,
) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    page = 1
    while True:
        batch = await client.get_shipments(limit=page_size, page=page)
        if not batch:
            break
        out.extend([b for b in batch if isinstance(b, dict)])
        if len(batch) < page_size:
            break
        page += 1
    return out


async def _fetch_details_by_awb(
    client: postis_client.PostisClient,
    awbs: List[str],
    *,
    concurrency: int,
) -> Tuple[List[Dict[str, Any]], int]:
    if not awbs:
        return [], 0

    sem = asyncio.Semaphore(max(1, int(concurrency or 1)))
    results: List[Dict[str, Any]] = []
    errors = 0

    async def fetch_one(awb: str) -> None:
        nonlocal errors
        async with sem:
            try:
                data = await client.get_shipment_tracking_by_awb_or_client_order_id(awb)
                if isinstance(data, dict) and data:
                    results.append(data)
                else:
                    errors += 1
            except Exception:
                errors += 1

    await asyncio.gather(*(fetch_one(a) for a in awbs))
    return results, errors


async def sync_postis_once(client: postis_client.PostisClient, *, config: Optional[PostisSyncConfig] = None) -> PostisSyncStats:
    cfg = config or load_config_from_env()

    started_at = datetime.now(timezone.utc).replace(tzinfo=None)

    # Ensure we honor env overrides for the stats subdomain.
    stats_base = os.getenv("POSTIS_STATS_BASE_URL")
    if stats_base:
        client.stats_base_url = str(stats_base).strip().rstrip("/")

    list_items = 0
    unique_awbs = 0
    new_awbs = 0
    changed_awbs = 0
    fetched_details = 0
    upserted = 0
    fetch_errors = 0
    upsert_errors = 0

    try:
        if not (client.username and client.password):
            logger.info("AUTO_SYNC_POSTIS enabled but POSTIS_USERNAME/POSTIS_PASSWORD missing; skipping")
            finished_at = datetime.now(timezone.utc).replace(tzinfo=None)
            return PostisSyncStats(
                started_at=started_at,
                finished_at=finished_at,
                list_items=0,
                unique_awbs=0,
                new_awbs=0,
                changed_awbs=0,
                fetched_details=0,
                upserted=0,
                fetch_errors=0,
                upsert_errors=0,
            )

        shipments_v3 = await _fetch_all_shipments_v3(client, page_size=cfg.page_size)
        list_items = len(shipments_v3)

        # Reduce to unique AWBs and compare metadata to DB to find changes.
        remote_state: Dict[str, Tuple[Optional[datetime], str, Optional[str]]] = {}
        for item in shipments_v3:
            awb = _extract_awb(item)
            if not awb:
                continue
            remote_state[awb] = (
                _parse_dt(item.get("awbStatusDate") or item.get("awb_status_date")),
                _normalize_status(item),
                str(item.get("processingStatus") or item.get("processing_status") or "").strip() or None,
            )

        unique_awbs = len(remote_state)

        changed, new_count = await asyncio.to_thread(
            _db_select_changed_awbs,
            remote_state,
            max_awbs_per_run=cfg.max_awbs_per_run,
            include_missing_raw=cfg.include_missing_raw,
        )
        new_awbs = new_count
        changed_awbs = len(changed)

        if not changed:
            finished_at = datetime.now(timezone.utc).replace(tzinfo=None)
            return PostisSyncStats(
                started_at=started_at,
                finished_at=finished_at,
                list_items=list_items,
                unique_awbs=unique_awbs,
                new_awbs=new_awbs,
                changed_awbs=0,
                fetched_details=0,
                upserted=0,
                fetch_errors=0,
                upsert_errors=0,
            )

        details, fetch_errors = await _fetch_details_by_awb(client, changed, concurrency=cfg.concurrency)
        fetched_details = len(details)

        upserted, upsert_errors = await asyncio.to_thread(_db_apply_postis_payloads, details)
    finally:
        finished_at = datetime.now(timezone.utc).replace(tzinfo=None)

    return PostisSyncStats(
        started_at=started_at,
        finished_at=finished_at,
        list_items=list_items,
        unique_awbs=unique_awbs,
        new_awbs=new_awbs,
        changed_awbs=changed_awbs,
        fetched_details=fetched_details,
        upserted=upserted,
        fetch_errors=fetch_errors,
        upsert_errors=upsert_errors,
    )


async def postis_poll_loop(client: postis_client.PostisClient, *, config: Optional[PostisSyncConfig] = None) -> None:
    cfg = config or load_config_from_env()
    if not cfg.enabled:
        logger.info("AUTO_SYNC_POSTIS not enabled; Postis poll loop will not start")
        return

    if cfg.startup_jitter_seconds:
        # Jitter to avoid hammering Postis if multiple instances start simultaneously.
        delay = random.uniform(0, float(cfg.startup_jitter_seconds))
        await asyncio.sleep(delay)

    next_run = time.monotonic()
    if not cfg.run_immediately:
        next_run += float(cfg.interval_seconds)

    while True:
        sleep_s = next_run - time.monotonic()
        if sleep_s > 0:
            await asyncio.sleep(sleep_s)

        run_started = time.monotonic()
        try:
            stats = await sync_postis_once(client, config=cfg)
            dur_s = (stats.finished_at - stats.started_at).total_seconds()
            logger.info(
                "Postis sync: list=%s unique_awbs=%s changed=%s new=%s fetched=%s upserted=%s "
                "fetch_errors=%s upsert_errors=%s duration_s=%.1f",
                stats.list_items,
                stats.unique_awbs,
                stats.changed_awbs,
                stats.new_awbs,
                stats.fetched_details,
                stats.upserted,
                stats.fetch_errors,
                stats.upsert_errors,
                dur_s,
            )
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.error("Postis sync failed: %s", str(e), exc_info=True)

        # Keep a steady cadence measured from the start of each run.
        next_run = run_started + float(cfg.interval_seconds)

