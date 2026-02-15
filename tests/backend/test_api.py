import os
import tempfile

import pytest
from fastapi.testclient import TestClient

# Force tests to use a local SQLite DB, not backend/.env.
_tmp_db = tempfile.NamedTemporaryFile(prefix="arynik-test-", suffix=".db", delete=False)
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from backend.database import engine
from backend.models import Base

Base.metadata.create_all(bind=engine)

from backend.main import app

client = TestClient(app)

def test_login_fail():
    response = client.post("/login", data={"username": "wrong", "password": "wrong"})
    assert response.status_code == 401

def test_status_options_no_auth():
    response = client.get("/status-options")
    assert response.status_code == 401
