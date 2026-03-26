import sqlite3

def clear_fleet_connections():
    db_path = 'postis_pwa.db'
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        
        # Disable foreign keys temporarily if sqlite allows
        cursor.execute("PRAGMA foreign_keys = OFF;")
        
        # Delete deactivated drivers
        cursor.execute("DELETE FROM drivers WHERE active = 0 OR active IS NULL OR active = '0' OR active = 'false';")
        print(f"Deleted {cursor.rowcount} deactivated drivers")
        
        # Delete deactivated fleet vehicles
        cursor.execute("DELETE FROM fleet_vehicles WHERE active = 0 OR active IS NULL OR active = '0' OR active = 'false';")
        print(f"Deleted {cursor.rowcount} deactivated vehicles")

        # Just to be absolutely sure all assignments are wiped for active ones too
        cursor.execute("UPDATE fleet_vehicles SET assigned_driver_id = NULL, assigned_driver_name = NULL, assigned_phone = NULL;")
        cursor.execute("UPDATE fleet_phone_numbers SET assigned_driver_id = NULL, assigned_vehicle_id = NULL;")
        cursor.execute("UPDATE drivers SET truck_plate = NULL;")
        
        conn.commit()
        print("Success! All inactive entities hard-deleted and active assignments wiped.")
    except Exception as e:
        print("Error:", str(e))
    finally:
        if 'conn' in locals():
            conn.close()

if __name__ == '__main__':
    clear_fleet_connections()
