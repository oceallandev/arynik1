import pandas as pd
import requests

sheet_url = "https://docs.google.com/spreadsheets/d/1jjX0Qdi9JEVs2wodFqK56yD5WqYVwL1KYjUrHMQBS0A/edit#gid=0"

def get_csv_url(url):
    if "edit#gid=" in url:
        return url.replace("edit#gid=", "export?format=csv&gid=")
    elif "/edit" in url:
        return url.replace("/edit", "/export?format=csv")
    return url

csv_url = get_csv_url(sheet_url)
print(f"Original: {sheet_url}")
print(f"Converted: {csv_url}")

try:
    response = requests.get(csv_url)
    print(f"Status Code: {response.status_code}")
    if response.status_code == 200:
        print("Success! CSV content found.")
        print(response.text[:200])
    else:
        print(f"Failed to fetch CSV: {response.text[:200]}")
except Exception as e:
    print(f"Error: {str(e)}")
