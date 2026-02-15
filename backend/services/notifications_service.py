from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

try:
    from .. import models
except ImportError:  # pragma: no cover
    import models  # type: ignore


def ensure_notifications_schema(db: Session) -> bool:
    """
    Create the notifications table if missing.

    We keep this separate from the column runtime migrations for shipments/drivers.
    """
    try:
        models.Notification.__table__.create(bind=db.get_bind(), checkfirst=True)
        return True
    except Exception:
        # Avoid blocking the API if DDL is not allowed (managed DBs).
        return False


def create_notification(
    db: Session,
    *,
    user_id: str,
    title: str,
    body: str,
    awb: Optional[str] = None,
    data: Optional[Dict[str, Any]] = None,
) -> Optional[models.Notification]:
    if not ensure_notifications_schema(db):
        return None
    notif = models.Notification(
        user_id=str(user_id or "").strip(),
        title=str(title or "").strip(),
        body=str(body or "").strip(),
        awb=(str(awb or "").strip().upper() or None),
        data=data,
        created_at=datetime.utcnow(),
        read_at=None,
    )
    db.add(notif)
    return notif
