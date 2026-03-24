import sqlite3
import os

db_path = "backend/arynik.db"
if os.path.exists(db_path):
    conn = sqlite3.connect(db_path)
    c = conn.cursor()
    try:
        c.execute("SELECT * FROM activity_logs ORDER BY timestamp DESC LIMIT 5")
        rows = c.fetchall()
        print("Activity Logs:", rows)
    except Exception as e:
        print("Error:", e)
else:
    print("Database not found at", db_path)
