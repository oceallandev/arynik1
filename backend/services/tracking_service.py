from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session

try:
    from .. import models
except ImportError:  # pragma: no cover
    import models  # type: ignore


def ensure_tracking_schema(db: Session) -> bool:
    """
    Create the tracking_requests table if missing.

    Keep this "best effort" to avoid blocking the API on managed DBs that do not
    allow DDL at runtime.
    """
    try:
        models.TrackingRequest.__table__.create(bind=db.get_bind(), checkfirst=True)
        return True
    except Exception:
        return False


def is_request_active(req: models.TrackingRequest, *, now: Optional[datetime] = None) -> bool:
    now = now or datetime.utcnow()
    if not req:
        return False
    if str(req.status or "").strip().lower() != "accepted":
        return False
    if req.stopped_at is not None:
        return False
    if req.expires_at is None:
        return False
    return req.expires_at > now
