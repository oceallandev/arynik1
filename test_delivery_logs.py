import sys
import traceback
sys.path.append("backend")

try:
    from fastapi.testclient import TestClient
    from main import app, get_current_active_driver
    from authz import PERM_LOGS_READ_ALL
    import models

    def mock_auth(*args, **kwargs):
        return models.Driver(driver_id="admin_test", role="admin")

    app.dependency_overrides[get_current_active_driver] = mock_auth

    client = TestClient(app)
    response = client.get("/delivery-logs")
    print("STATUS CODE:", response.status_code)
    if response.status_code != 200:
        print("ERROR:", response.text)
except Exception as e:
    traceback.print_exc()
