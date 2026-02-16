from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

try:
    from .. import models
except ImportError:  # pragma: no cover
    import models  # type: ignore


def ensure_contacts_schema(db: Session) -> bool:
    """
    Create the contact_attempts table if missing.
    """
    try:
        models.ContactAttempt.__table__.create(bind=db.get_bind(), checkfirst=True)
        return True
    except Exception:
        return False


def log_contact_attempt(
    db: Session,
    *,
    created_by_user_id: str,
    created_by_role: Optional[str],
    awb: Optional[str],
    channel: str,
    to_phone: Optional[str],
    outcome: Optional[str] = None,
    notes: Optional[str] = None,
    data: Optional[Dict[str, Any]] = None,
) -> Optional[models.ContactAttempt]:
    if not ensure_contacts_schema(db):
        return None

    attempt = models.ContactAttempt(
        created_at=datetime.utcnow(),
        created_by_user_id=str(created_by_user_id or "").strip(),
        created_by_role=(str(created_by_role or "").strip() or None),
        awb=(str(awb or "").strip().upper() or None),
        channel=(str(channel or "").strip().lower() or "call"),
        to_phone=(str(to_phone or "").strip() or None),
        outcome=(str(outcome or "").strip() or None),
        notes=(str(notes or "").strip() or None),
        data=data,
    )
    db.add(attempt)
    return attempt

