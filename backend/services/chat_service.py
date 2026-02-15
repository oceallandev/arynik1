from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session

try:
    from .. import models
except ImportError:  # pragma: no cover
    import models  # type: ignore


def ensure_chat_schema(db: Session) -> bool:
    """
    Best-effort schema initializer (SQLite local DB / unmanaged Postgres).

    If DDL is not allowed, we return False so callers can degrade gracefully.
    """
    try:
        models.ChatThread.__table__.create(bind=db.get_bind(), checkfirst=True)
        models.ChatParticipant.__table__.create(bind=db.get_bind(), checkfirst=True)
        models.ChatMessage.__table__.create(bind=db.get_bind(), checkfirst=True)
        return True
    except Exception:
        return False


def get_or_create_awb_thread(
    db: Session,
    *,
    awb: str,
    created_by_user_id: Optional[str] = None,
    created_by_role: Optional[str] = None,
) -> Optional[models.ChatThread]:
    if not ensure_chat_schema(db):
        return None

    key = str(awb or "").strip().upper()
    if not key:
        return None

    existing = db.query(models.ChatThread).filter(models.ChatThread.awb == key).first()
    if existing:
        return existing

    now = datetime.utcnow()
    thread = models.ChatThread(
        created_at=now,
        created_by_user_id=(str(created_by_user_id or "").strip() or None),
        created_by_role=(str(created_by_role or "").strip() or None),
        awb=key,
        subject=f"AWB {key}",
        last_message_at=None,
    )
    db.add(thread)
    db.flush()  # ensure thread.id
    return thread


def ensure_participant(
    db: Session,
    *,
    thread_id: int,
    user_id: str,
    role: Optional[str] = None,
) -> Optional[models.ChatParticipant]:
    if not ensure_chat_schema(db):
        return None

    tid = int(thread_id)
    uid = str(user_id or "").strip().upper()
    if not tid or not uid:
        return None

    existing = (
        db.query(models.ChatParticipant)
        .filter(models.ChatParticipant.thread_id == tid, models.ChatParticipant.user_id == uid)
        .first()
    )
    if existing:
        if role and not existing.role:
            existing.role = str(role).strip()
        return existing

    part = models.ChatParticipant(
        thread_id=tid,
        user_id=uid,
        role=(str(role).strip() if role else None),
        joined_at=datetime.utcnow(),
        last_read_message_id=None,
    )
    db.add(part)
    return part

