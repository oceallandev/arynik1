
import requests
import sys

def verify():
    base_url = "http://localhost:8000"
    print(f"--- VERIFYING BACKEND AT {base_url} ---")
    
    # 1. Check Root/Docs
    try:
        r = requests.get(f"{base_url}/docs")
        if r.status_code == 200:
            print("✅ Backend is reachable (/docs)")
        else:
            print(f"❌ Backend returned {r.status_code}")
            return
    except Exception as e:
        print(f"❌ Backend unreachable: {e}")
        return

    # 2. Test Login
    print("\n--- TESTING LOGIN ---")
    try:
        r = requests.post(f"{base_url}/login", 
                         data={"username": "demo", "password": "demo"},
                         headers={"Content-Type": "application/x-www-form-urlencoded"})
        if r.status_code == 200:
            data = r.json()
            token = data.get("access_token")
            role = data.get("role")
            print(f"✅ Login successful! Token: {token[:10]}... Role: {role}")
        else:
            print(f"❌ Login failed: {r.status_code} - {r.text}")
            return
    except Exception as e:
        print(f"❌ Login error: {e}")
        return

    # 3. Test Shipments
    print("\n--- TESTING SHIPMENTS ---")
    try:
        r = requests.get(f"{base_url}/shipments", 
                        headers={"Authorization": f"Bearer {token}"})
        if r.status_code == 200:
            shipments = r.json()
            print(f"✅ Retrieved {len(shipments)} shipments")
            if shipments:
                s = shipments[0]
                print(f"   Sample AWB: {s.get('awb')}")
                print(f"   Recipient:  {s.get('recipient_name')}")
                print(f"   Phone:      {s.get('recipient_phone')}")
                print(f"   Valid Address: {bool(s.get('delivery_address'))}")
        else:
            print(f"❌ Shipments fetch failed: {r.status_code} - {r.text}")
    except Exception as e:
        print(f"❌ Shipments error: {e}")

if __name__ == "__main__":
    verify()
