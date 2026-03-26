from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite:///{BASE_DIR}/postis_pwa.db")

if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

def _normalize_sqlite_url(url: str) -> str:
    """
    Ensure relative sqlite paths are resolved relative to the backend/ directory,
    not the process working directory. This avoids accidental DB splits when
    running `uvicorn backend.main:app` from repo root vs `backend/`.
    """
    if not url.startswith("sqlite:///"):
        return url

    # Absolute paths are represented as sqlite:////abs/path (4 slashes).
    if url.startswith("sqlite:////"):
        return url

    rel_path = url[len("sqlite:///"):]
    if rel_path.startswith("./"):
        rel_path = rel_path[2:]
    abs_path = (BASE_DIR / rel_path).resolve()
    return f"sqlite:///{abs_path}"

DATABASE_URL = _normalize_sqlite_url(DATABASE_URL)

engine_kwargs = {}
if "sqlite" in DATABASE_URL:
    engine_kwargs["connect_args"] = {
        "check_same_thread": False,
        "timeout": 30,
    }
else:
    # Avoid stale pooled connections on managed Postgres providers (Render/Supabase/etc.).
    engine_kwargs["pool_pre_ping"] = True
    engine_kwargs["pool_recycle"] = 1800

engine = create_engine(DATABASE_URL, **engine_kwargs)

if "sqlite" in DATABASE_URL:
    from sqlalchemy import event
    @event.listens_for(engine, "connect")
    def set_sqlite_pragma(dbapi_connection, connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.execute("PRAGMA busy_timeout=5000")
        cursor.execute("PRAGMA cache_size=-64000")
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
