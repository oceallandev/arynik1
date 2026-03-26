import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "backend"))

import pandas as pd
from backend.main import _manifest_import_parse_upload

# Create a dummy excel file in memory
import io
df = pd.DataFrame({"awb": ["AWB123", "AWB456"]})
buffer = io.BytesIO()
df.to_excel(buffer, index=False)
excel_bytes = buffer.getvalue()

try:
    values, count = _manifest_import_parse_upload("test.xlsx", excel_bytes)
    print("SUCCESS!", values, count)
except Exception as e:
    print("FAILED!", repr(e))
