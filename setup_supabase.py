import os
from dotenv import load_dotenv

# Load env before importing database
load_dotenv("backend/.env")

from backend.database import SessionLocal, engine, Base
from backend.models import Driver, Todo
from backend.driver_manager import get_password_hash
from backend.services import drivers_service

# Define the data
drivers_data = [
    {"plate": "BC75ARI", "phone": "0753670469", "name": "Borca Marius", "helper": "Cristi"},
    {"plate": "BC55NIK", "phone": "0757717545", "name": "Nita Gabi", "helper": "Costica"},
    {"plate": "BC91ARY", "phone": "0792621163", "name": "Vijaica Lucian", "helper": "Marius"},
    {"plate": "BC01NIK", "phone": "0755201704", "name": "Costea Vasile", "helper": "Ionica"},
    {"plate": "BC43NYC", "phone": "0754267757", "name": "Carnaianu Ciprian", "helper": "Alex"},
    {"plate": "BC58ARI", "phone": "0741611414", "name": "Turi Catalin", "helper": "Ciprian"},
    {"plate": None, "phone": None, "name": "Gabi V", "helper": "Borca Marius"} # Gabi V has no truck/phone in immediate list? Or maybe I should skip if incomplete? I'll add anyway.
]

ADMIN_ACCOUNTS = [
    # Super admin
    {"driver_id": "D001", "username": "admin", "name": "Super Admin", "role": "Admin", "password_env": "SUPER_ADMIN_PASSWORD", "default_password": "admin"},
    # 3 admin accounts
    {"driver_id": "D901", "username": "admin2", "name": "Admin 2", "role": "Admin", "password_env": "ADMIN2_PASSWORD", "default_password": "admin2"},
    {"driver_id": "D902", "username": "admin3", "name": "Admin 3", "role": "Admin", "password_env": "ADMIN3_PASSWORD", "default_password": "admin3"},
    {"driver_id": "D903", "username": "admin4", "name": "Admin 4", "role": "Admin", "password_env": "ADMIN4_PASSWORD", "default_password": "admin4"},
]

DEFAULT_DRIVER_PASSWORD = os.getenv("DEFAULT_DRIVER_PASSWORD", "1234")
DEMO_PASSWORD = os.getenv("DEMO_PASSWORD", "demo")

RESET_PASSWORDS = os.getenv("RESET_PASSWORDS", "").strip().lower() in ("1", "true", "yes", "on")

def setup_db():
    print("🔄 Connecting to Supabase and creating tables...")
    try:
        # Create all tables (including new Todo and updated Driver)
        Base.metadata.create_all(bind=engine)
        print("✅ Tables created (if they didn't exist).")
    except Exception as e:
        print(f"❌ Error creating tables: {e}")
        return

    db = SessionLocal()

    # If the drivers table already exists, make sure optional allocation columns exist.
    try:
        drivers_service.ensure_drivers_schema(db)
    except Exception as e:
        print(f"⚠️  Could not ensure drivers schema: {e}")
    
    print("🔄 Seeding Drivers...")
    for i, d in enumerate(drivers_data):
        # Generate username: first letter firstname + lastname? 
        # Or just use name with no spaces?
        # Usernames must be unique.
        # "Borca Marius" -> "borcamarius"
        username = d["name"].lower().replace(" ", "")
        
        # ID: D003, D004... (Admin is D001, Demo is D002)
        driver_id = f"D{str(i+3).zfill(3)}"
        
        existing = (
            db.query(Driver)
            .filter((Driver.driver_id == driver_id) | (Driver.username == username))
            .first()
        )
        if not existing:
            new_driver = Driver(
                driver_id=driver_id,
                name=d["name"],
                username=username,
                password_hash=get_password_hash(DEFAULT_DRIVER_PASSWORD), # Default password
                role="Driver",
                truck_plate=d["plate"],
                phone_number=d["phone"],
                helper_name=d["helper"]
            )
            db.add(new_driver)
            print(f"✨ Added driver: {d['name']} ({username})")
        else:
            # Update existing
            existing.truck_plate = d["plate"]
            existing.phone_number = d["phone"]
            existing.helper_name = d["helper"]
            existing.name = d["name"]
            existing.username = username
            existing.role = "Driver"
            existing.active = True
            if RESET_PASSWORDS:
                existing.password_hash = get_password_hash(DEFAULT_DRIVER_PASSWORD)
            print(f"📝 Updated driver: {d['name']}")
    
    print("🔄 Seeding Admin Accounts...")
    for spec in ADMIN_ACCOUNTS:
        username = spec["username"]
        driver_id = spec["driver_id"]
        password = os.getenv(spec["password_env"], spec["default_password"])

        existing = (
            db.query(Driver)
            .filter((Driver.driver_id == driver_id) | (Driver.username == username))
            .first()
        )

        if not existing:
            db.add(
                Driver(
                    driver_id=driver_id,
                    name=spec["name"],
                    username=username,
                    password_hash=get_password_hash(password),
                    role=spec["role"],
                    active=True,
                )
            )
            print(f"✨ Added admin: {username} ({driver_id})")
        else:
            existing.name = spec["name"]
            existing.username = username
            existing.role = spec["role"]
            existing.active = True
            if RESET_PASSWORDS:
                existing.password_hash = get_password_hash(password)
            print(f"📝 Updated admin: {username} ({driver_id})")

    # Ensure Demo account exists (useful for non-production showcases).
    demo = db.query(Driver).filter((Driver.driver_id == "D002") | (Driver.username == "demo")).first()
    if not demo:
        db.add(
            Driver(
                driver_id="D002",
                name="Demo Driver",
                username="demo",
                password_hash=get_password_hash(DEMO_PASSWORD),
                role="Driver",
                active=True,
                truck_plate="DEMO-01",
                phone_number="0000000000",
            )
        )
        print("✨ Added demo driver (demo)")
    else:
        demo.name = "Demo Driver"
        demo.username = "demo"
        demo.role = "Driver"
        demo.active = True
        if RESET_PASSWORDS:
            demo.password_hash = get_password_hash(DEMO_PASSWORD)
        print("📝 Updated demo driver (demo)")

    db.commit()
    print("✅ Drivers seeded successfully.")
    
    # Check Todos
    print("🔄 Checking Todos table...")
    # (Table created by create_all). We can insert a sample todo.
    if db.query(Todo).count() == 0:
        db.add(Todo(task="Inspect Truck", status="Not Started", user_id="D002"))
        db.commit()
        print("✨ Added sample todo.")

    db.close()
    print("🎉 Database setup complete!")

if __name__ == "__main__":
    setup_db()
