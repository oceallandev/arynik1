import os
import sys

# Ensure backend finds proper paths
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), 'backend')))

from database import engine
from models import ActivityLog

def migrate():
    print("Creating ActivityLog table...")
    ActivityLog.__table__.create(bind=engine, checkfirst=True)
    print("Table created successfully!")

if __name__ == "__main__":
    migrate()
