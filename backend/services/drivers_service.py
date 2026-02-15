from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.orm import Session

try:
    from .phone_service import normalize_phone
except ImportError:  # pragma: no cover
    from phone_service import normalize_phone  # type: ignore


def ensure_drivers_schema(db: Session) -> None:
    """
    Lightweight runtime migration for the drivers table.

    The project historically shipped SQLite DBs without the optional truck allocation columns,
    while the SQLAlchemy model already expects them. Missing columns break auth queries.
    """
    try:
        dialect = db.bind.dialect.name  # type: ignore[union-attr]
    except Exception:
        dialect = ""

    columns = [
        ("truck_plate", "TEXT", "TEXT"),
        ("phone_number", "TEXT", "TEXT"),
        ("phone_norm", "TEXT", "TEXT"),
        ("helper_name", "TEXT", "TEXT"),
    ]

    if dialect == "postgresql":
        try:
            exists = db.execute(
                text("SELECT 1 FROM information_schema.tables WHERE table_name = 'drivers' LIMIT 1")
            ).fetchone()
        except Exception:
            exists = None
        if not exists:
            return

        for name, pg_type, _sqlite_type in columns:
            db.execute(text(f"ALTER TABLE drivers ADD COLUMN IF NOT EXISTS {name} {pg_type}"))
        db.commit()
        return

    if dialect == "sqlite":
        try:
            exists = db.execute(
                text("SELECT name FROM sqlite_master WHERE type='table' AND name='drivers' LIMIT 1")
            ).fetchone()
        except Exception:
            exists = None
        if not exists:
            return

        existing = [row[1] for row in db.execute(text("PRAGMA table_info(drivers)")).fetchall()]
        for name, _pg_type, sqlite_type in columns:
            if name in existing:
                continue
            db.execute(text(f"ALTER TABLE drivers ADD COLUMN {name} {sqlite_type}"))
            db.commit()
        return


def backfill_phone_norm(db: Session, *, batch_size: int = 2000, max_batches: int = 20) -> int:
    """
    Populate phone_norm for existing users/drivers.

    Note: for driver accounts, phone_number is currently used as the allocated truck phone.
    For recipient accounts, it's the recipient WhatsApp phone. We still normalize both.
    """
    ensure_drivers_schema(db)

    total_changed = 0
    for _ in range(max_batches):
        rows = (
            db.execute(
                text(
                    "SELECT id, phone_number FROM drivers "
                    "WHERE phone_number IS NOT NULL AND (phone_norm IS NULL OR phone_norm = '') "
                    f"LIMIT {max(1, int(batch_size or 2000))}"
                )
            ).fetchall()
        )
        if not rows:
            break

        changed = 0
        for row in rows:
            row_id, phone_number = row[0], row[1]
            norm = normalize_phone(phone_number) if phone_number else None
            if not norm:
                continue
            db.execute(text("UPDATE drivers SET phone_norm = :norm WHERE id = :id"), {"norm": norm, "id": row_id})
            changed += 1

        if changed:
            db.commit()
            total_changed += changed
        else:
            break

    return total_changed
