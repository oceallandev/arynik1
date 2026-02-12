import pytest
from fastapi.testclient import TestClient
from backend.main import app

client = TestClient(app)

def test_login_fail():
    response = client.post("/login", data={"username": "wrong", "password": "wrong"})
    assert response.status_code == 401

def test_status_options_no_auth():
    response = client.get("/status-options")
    assert response.status_code == 401
