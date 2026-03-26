import sys
import os

backend_dir = os.path.dirname(os.path.abspath(__file__))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

import database
import models
import driver_manager

def check():
    db = next(database.get_db())
    driver = db.query(models.Driver).filter_by(username="testlivrare").first()
    if not driver:
        print("Driver not found!")
        return

    print("Driver found:", driver.username)
    print("Driver active:", driver.active)
    print("Driver role:", driver.role)
    print("Driver hash:", driver.password_hash)
    print("Verifying password '1':", driver_manager.verify_password("1", driver.password_hash))

if __name__ == "__main__":
    check()
