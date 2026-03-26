import sys
import os
import io

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "backend"))

from fastapi.testclient import TestClient
from backend.main import app, get_current_driver
from backend import models

def mock_get_current_driver():
    user = models.Driver()
    user.id = 1
    user.driver_id = "ADMIN123"
    user.role = "Admin"
    return user

app.dependency_overrides[get_current_driver] = mock_get_current_driver

client = TestClient(app)

manifest_payload = {
    "truck_plate": "B123ABC",
    "date": "2026-03-26",
    "kind": "unload",
    "notes": "test"
}
m_resp = client.post("/manifests", json=manifest_payload)
m_id = m_resp.json()["id"]

file_content = b"NEWTEST12345100\nNEWTEST12345100"
response = client.post(
    f"/manifests/{m_id}/import-awbs",
    files={"file": ("test.csv", io.BytesIO(file_content), "text/csv")}
)

print("Import AWBs status:", response.status_code)
print("Import AWBs text:", response.text)
