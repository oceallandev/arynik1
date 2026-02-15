-- Drivers Table
CREATE TABLE IF NOT EXISTS drivers (
    id SERIAL PRIMARY KEY,
    driver_id VARCHAR UNIQUE,
    name VARCHAR,
    username VARCHAR UNIQUE,
    password_hash VARCHAR,
    role VARCHAR,
    active BOOLEAN DEFAULT TRUE,
    last_login TIMESTAMP,
    truck_plate VARCHAR,
    phone_number VARCHAR,
    helper_name VARCHAR
);

-- Shipments Table
CREATE TABLE IF NOT EXISTS shipments (
    id SERIAL PRIMARY KEY,
    awb VARCHAR UNIQUE,
    status VARCHAR,
    recipient_name VARCHAR,
    recipient_phone VARCHAR,
    recipient_email VARCHAR,
    delivery_address VARCHAR,
    locality VARCHAR,
    latitude FLOAT,
    longitude FLOAT,
    weight FLOAT,
    volumetric_weight FLOAT,
    dimensions VARCHAR,
    content_description VARCHAR,
    cod_amount FLOAT DEFAULT 0.0,
    delivery_instructions VARCHAR,
    driver_id VARCHAR REFERENCES drivers(driver_id),
    last_updated TIMESTAMP DEFAULT NOW(),
    shipment_reference VARCHAR,
    client_order_id VARCHAR,
    postis_order_id VARCHAR,
    client_data JSONB,
    courier_data JSONB,
    sender_location JSONB,
    recipient_location JSONB,
    product_category_data JSONB,
    client_shipment_status_data JSONB,
    additional_services JSONB,
    raw_data JSONB,
    created_date TIMESTAMP,
    awb_status_date TIMESTAMP,
    local_awb_shipment BOOLEAN DEFAULT FALSE,
    local_shipment BOOLEAN DEFAULT FALSE,
    shipment_label_available BOOLEAN DEFAULT FALSE,
    has_borderou BOOLEAN DEFAULT FALSE,
    pallet_package BOOLEAN DEFAULT FALSE,
    source_channel VARCHAR,
    send_type VARCHAR,
    sender_shop_name VARCHAR,
    processing_status VARCHAR,
    number_of_parcels INTEGER DEFAULT 1,
    declared_value FLOAT DEFAULT 0.0
);

-- Shipment Events
CREATE TABLE IF NOT EXISTS shipment_events (
    id SERIAL PRIMARY KEY,
    shipment_id INTEGER REFERENCES shipments(id),
    event_description VARCHAR,
    event_date TIMESTAMP,
    locality_name VARCHAR
);

-- Driver Location history
CREATE TABLE IF NOT EXISTS driver_locations (
    id SERIAL PRIMARY KEY,
    driver_id VARCHAR,
    latitude FLOAT,
    longitude FLOAT,
    timestamp TIMESTAMP DEFAULT NOW()
);

-- Logs
CREATE TABLE IF NOT EXISTS log_entries (
    id SERIAL PRIMARY KEY,
    driver_id VARCHAR REFERENCES drivers(driver_id),
    timestamp TIMESTAMP DEFAULT NOW(),
    awb VARCHAR,
    event_id VARCHAR,
    outcome VARCHAR,
    error_message VARCHAR,
    postis_reference VARCHAR,
    payload JSONB,
    idempotency_key VARCHAR UNIQUE
);

-- Status Options
CREATE TABLE IF NOT EXISTS status_options (
    id SERIAL PRIMARY KEY,
    event_id VARCHAR UNIQUE,
    label VARCHAR,
    description VARCHAR,
    requirements JSONB
);

-- Todos (New)
CREATE TABLE IF NOT EXISTS todos (
    id SERIAL PRIMARY KEY,
    task VARCHAR,
    status VARCHAR DEFAULT 'Not Started',
    user_id VARCHAR REFERENCES drivers(driver_id),
    inserted_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- SEED DATA --

-- Drivers
-- Hashes: 1234 -> a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3 (sha256)
-- Admin/Demo: admin/demo
INSERT INTO drivers (driver_id, name, username, password_hash, role, truck_plate, phone_number, helper_name)
VALUES 
('D001', 'Admin User', 'admin', '8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918', 'admin', NULL, NULL, NULL),
('D002', 'Demo Driver', 'demo', '2a97516c354b68848cdbd8f54a226a0a55b21ed138e207ad6c5cbb9c00aa5aea', 'driver', 'DEMO-01', '0000000000', NULL),
('D003', 'Borca Marius', 'borcamarius', '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4', 'driver', 'BC75ARI', '0753670469', 'Cristi'),
('D004', 'Nita Gabi', 'nitagabi', '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4', 'driver', 'BC55NIK', '0757717545', 'Costica'),
('D005', 'Vijaica Lucian', 'vijaicalucian', '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4', 'driver', 'BC91ARY', '0792621163', 'Marius'),
('D006', 'Costea Vasile', 'costeavasile', '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4', 'driver', 'BC01NIK', '0755201704', 'Ionica'),
('D007', 'Carnaianu Ciprian', 'carnaianuciprian', '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4', 'driver', 'BC43NYC', '0754267757', 'Alex'),
('D008', 'Turi Catalin', 'turicatalin', '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4', 'driver', 'BC58ARI', '0741611414', 'Ciprian'),
('D009', 'Gabi V', 'gabiv', '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4', 'driver', NULL, NULL, 'Borca Marius')
ON CONFLICT (driver_id) DO NOTHING;

-- Todos
INSERT INTO todos (task, status, user_id)
VALUES ('Inspect Truck', 'Not Started', 'D002');
