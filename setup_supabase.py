import os
from dotenv import load_dotenv

# Load env before importing database
load_dotenv("backend/.env")

from backend.database import SessionLocal, engine, Base
from backend.models import Driver, Todo
from backend.driver_manager import get_password_hash

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
    
    print("🔄 Seeding Drivers...")
    for i, d in enumerate(drivers_data):
        # Generate username: first letter firstname + lastname? 
        # Or just use name with no spaces?
        # Usernames must be unique.
        # "Borca Marius" -> "borcamarius"
        username = d["name"].lower().replace(" ", "")
        
        # ID: D003, D004... (Admin is D001, Demo is D002)
        driver_id = f"D{str(i+3).zfill(3)}"
        
        existing = db.query(Driver).filter(Driver.username == username).first()
        if not existing:
            new_driver = Driver(
                driver_id=driver_id,
                name=d["name"],
                username=username,
                password_hash=get_password_hash("1234"), # Default password
                role="driver",
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
            print(f"📝 Updated driver: {d['name']}")
    
    # Ensure Admin and Demo exist
    if not db.query(Driver).filter(Driver.username == "admin").first():
        db.add(Driver(driver_id="D001", name="Admin User", username="admin", password_hash=get_password_hash("admin"), role="admin"))
    
    if not db.query(Driver).filter(Driver.username == "demo").first():
        db.add(Driver(driver_id="D002", name="Demo Driver", username="demo", password_hash=get_password_hash("demo"), role="driver", truck_plate="DEMO-01", phone_number="0000000000"))

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
