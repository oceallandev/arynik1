import sys
import os
import io

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "backend"))

from fastapi.testclient import TestClient
from backend.main import app

client = TestClient(app)

file_content = b"awb1\nawb2\n"
response = client.post(
    "/manifests/1/import-awbs",
    files={"file": ("test.txt", io.BytesIO(file_content), "text/plain")}
)

print("Response status:", response.status_code)
print("Response text:", response.text)
