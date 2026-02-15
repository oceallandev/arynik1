import os
import psycopg2
from dotenv import load_dotenv
from urllib.parse import urlsplit, urlunsplit

load_dotenv("backend/.env")

url = os.getenv("DATABASE_URL")

def _mask_db_url(value: str) -> str:
    if not value:
        return value
    try:
        parts = urlsplit(value)
        if not parts.scheme or not parts.netloc:
            return value

        hostname = parts.hostname or ""
        if parts.port:
            hostname = f"{hostname}:{parts.port}"

        user = parts.username or ""
        netloc = hostname
        if user:
            netloc = f"{user}:***@{hostname}"

        return urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))
    except Exception:
        return value

print(f"Testing connection to: {_mask_db_url(url)}")

try:
    conn = psycopg2.connect(url)
    print("✅ Connection Successful!")
    cur = conn.cursor()
    cur.execute("SELECT count(*) FROM drivers;")
    count = cur.fetchone()[0]
    print(f"📊 Driver Count: {count}")
    cur.close()
    conn.close()
except Exception as e:
    print(f"❌ Connection Failed: {e}")
