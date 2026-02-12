import pandas as pd
import logging
from typing import List, Dict, Any
import os

logger = logging.getLogger(__name__)

class ShipmentManager:
    def __init__(self, sheet_url: str):
        self.sheet_url = sheet_url

    def fetch_shipments_from_sheet(self) -> List[Dict[str, Any]]:
        try:
            if "edit#gid=" in self.sheet_url:
                csv_url = self.sheet_url.replace("edit#gid=", "export?format=csv&gid=")
            elif "/edit" in self.sheet_url:
                csv_url = self.sheet_url.replace("/edit", "/export?format=csv")
            else:
                csv_url = self.sheet_url
                
            df = pd.read_csv(csv_url)
            # The sheet format implied by the user's Apps Script:
            # Column 0: AWB, Column 6: AWBCode
            # We'll try to find headers or use indices
            shipments = []
            for _, row in df.iterrows():
                # Map columns based on Apps Script logic:
                # Column 0 (A) is the full AWB
                awb = str(row.iloc[0]).strip() if len(row) > 0 else None
                # Column 6 (G) is the AWBCode/BaseCode used for API tracking calls
                awb_code = str(row.iloc[6]).strip() if len(row) > 6 else (str(row.get('AWBCode','')).strip() if 'AWBCode' in row else awb)
                # Column 2 (C) is the StatusDesc / Description
                description = str(row.iloc[2]).strip() if len(row) > 2 else ""
                
                if awb and awb != 'nan' and awb != '':
                    shipments.append({
                        "awb": awb,
                        "awb_code": awb_code if awb_code and awb_code != 'nan' else awb,
                        "status": str(row.iloc[1]) if len(row) > 1 else None,
                        "description": description
                    })
            return shipments
        except Exception as e:
            logger.error(f"Error fetching shipments from sheet: {str(e)}")
            return []
