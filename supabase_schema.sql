-- Run this in Supabase SQL Editor (SQL only, not Python).
-- Safe to re-run (idempotent where possible).
SET search_path TO public;

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
    phone_norm VARCHAR,
    helper_name VARCHAR
);

-- Idempotent column adds for existing deployments.
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS last_login TIMESTAMP;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS truck_plate VARCHAR;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS phone_number VARCHAR;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS phone_norm VARCHAR;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS helper_name VARCHAR;
CREATE INDEX IF NOT EXISTS drivers_phone_norm_idx ON drivers(phone_norm);

-- Shipments Table
CREATE TABLE IF NOT EXISTS shipments (
    id SERIAL PRIMARY KEY,
    awb VARCHAR UNIQUE,
    status VARCHAR,
    recipient_name VARCHAR,
    recipient_phone VARCHAR,
    recipient_phone_norm VARCHAR,
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
    shipping_cost FLOAT,
    estimated_shipping_cost FLOAT,
    currency VARCHAR,
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

ALTER TABLE shipments ADD COLUMN IF NOT EXISTS recipient_phone_norm VARCHAR;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS shipping_cost FLOAT;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS estimated_shipping_cost FLOAT;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS currency VARCHAR;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS raw_data JSONB;
CREATE INDEX IF NOT EXISTS shipments_recipient_phone_norm_idx ON shipments(recipient_phone_norm);

-- In-app notifications (recipient/customer and internal users)
CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR REFERENCES drivers(driver_id),
    created_at TIMESTAMP DEFAULT NOW(),
    read_at TIMESTAMP,
    title VARCHAR,
    body VARCHAR,
    awb VARCHAR,
    data JSONB
);

CREATE INDEX IF NOT EXISTS notifications_user_id_created_at_idx ON notifications(user_id, created_at DESC);

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

-- Live tracking requests (share driver location for a limited time)
CREATE TABLE IF NOT EXISTS tracking_requests (
    id SERIAL PRIMARY KEY,
    created_at TIMESTAMP DEFAULT NOW(),
    created_by_user_id VARCHAR,
    created_by_role VARCHAR,
    target_driver_id VARCHAR,
    awb VARCHAR,
    status VARCHAR DEFAULT 'Pending',
    duration_sec INTEGER DEFAULT 900,
    expires_at TIMESTAMP,
    accepted_at TIMESTAMP,
    denied_at TIMESTAMP,
    stopped_at TIMESTAMP,
    last_location_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS tracking_requests_target_driver_id_idx ON tracking_requests(target_driver_id);
CREATE INDEX IF NOT EXISTS tracking_requests_awb_idx ON tracking_requests(awb);

-- In-app chat (shipment-linked threads by AWB)
CREATE TABLE IF NOT EXISTS chat_threads (
    id SERIAL PRIMARY KEY,
    created_at TIMESTAMP DEFAULT NOW(),
    created_by_user_id VARCHAR,
    created_by_role VARCHAR,
    awb VARCHAR UNIQUE,
    subject VARCHAR,
    last_message_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS chat_threads_awb_idx ON chat_threads(awb);
CREATE INDEX IF NOT EXISTS chat_threads_last_message_at_idx ON chat_threads(last_message_at DESC);

CREATE TABLE IF NOT EXISTS chat_participants (
    id SERIAL PRIMARY KEY,
    thread_id INTEGER REFERENCES chat_threads(id) ON DELETE CASCADE,
    user_id VARCHAR REFERENCES drivers(driver_id),
    role VARCHAR,
    joined_at TIMESTAMP DEFAULT NOW(),
    last_read_message_id INTEGER,
    CONSTRAINT uq_chat_participant_thread_user UNIQUE (thread_id, user_id)
);

CREATE INDEX IF NOT EXISTS chat_participants_user_id_idx ON chat_participants(user_id);
CREATE INDEX IF NOT EXISTS chat_participants_thread_id_idx ON chat_participants(thread_id);

CREATE TABLE IF NOT EXISTS chat_messages (
    id SERIAL PRIMARY KEY,
    thread_id INTEGER REFERENCES chat_threads(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW(),
    sender_user_id VARCHAR REFERENCES drivers(driver_id),
    sender_role VARCHAR,
    message_type VARCHAR DEFAULT 'text',
    text VARCHAR,
    data JSONB
);

CREATE INDEX IF NOT EXISTS chat_messages_thread_id_idx ON chat_messages(thread_id);
CREATE INDEX IF NOT EXISTS chat_messages_created_at_idx ON chat_messages(created_at DESC);

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
-- Hashes (sha256):
-- - 1234 -> 03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4
-- Admin/Demo: admin/demo
INSERT INTO drivers (driver_id, name, username, password_hash, role, truck_plate, phone_number, helper_name)
VALUES 
('D001', 'Admin User', 'admin', '8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918', 'admin', NULL, NULL, NULL),
('D901', 'Admin 2', 'admin2', '1c142b2d01aa34e9a36bde480645a57fd69e14155dacfab5a3f9257b77fdc8d8', 'admin', NULL, NULL, NULL),
('D902', 'Admin 3', 'admin3', '4fc2b5673a201ad9b1fc03dcb346e1baad44351daa0503d5534b4dfdcc4332e0', 'admin', NULL, NULL, NULL),
('D903', 'Admin 4', 'admin4', '110198831a426807bccd9dbdf54b6dcb5298bc5d31ac49069e0ba3d210d970ae', 'admin', NULL, NULL, NULL),
('D002', 'Demo Driver', 'demo', '2a97516c354b68848cdbd8f54a226a0a55b21ed138e207ad6c5cbb9c00aa5aea', 'driver', 'DEMO-01', '0000000000', NULL),
('D003', 'Borca Marius', 'borcamarius', '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4', 'driver', 'BC75ARI', '0753670469', 'Cristi'),
('D004', 'Nita Gabi', 'nitagabi', '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4', 'driver', 'BC55NIK', '0757717545', 'Costica'),
('D005', 'Vijaica Lucian', 'vijaicalucian', '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4', 'driver', 'BC91ARY', '0792621163', 'Marius'),
('D006', 'Costea Vasile', 'costeavasile', '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4', 'driver', 'BC01NIK', '0755201704', 'Ionica'),
('D007', 'Carnaianu Ciprian', 'carnaianuciprian', '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4', 'driver', 'BC43NYC', '0754267757', 'Alex'),
('D008', 'Turi Catalin', 'turicatalin', '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4', 'driver', 'BC58ARI', '0741611414', 'Ciprian'),
('D009', 'Gabi V', 'gabiv', '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4', 'driver', NULL, NULL, 'Borca Marius')
ON CONFLICT DO NOTHING;

-- Todos (idempotent seed)
INSERT INTO todos (task, status, user_id)
SELECT 'Inspect Truck', 'Not Started', 'D002'
WHERE NOT EXISTS (
    SELECT 1 FROM todos WHERE task = 'Inspect Truck' AND user_id = 'D002'
);
