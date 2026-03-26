import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "backend"))

from fastapi.testclient import TestClient
from backend.main import app

client = TestClient(app)

# We need a valid JWT token to test the endpoint. Or we can just see if it returns 401/403 instead of crashing.
response = client.post(
    "/manifests/1/import-awbs",
    data={"google_sheet_url": "https://docs.google.com/spreadsheets/d/abc/edit"},
)
print("Response status:", response.status_code)
print("Response data:", response.text)
