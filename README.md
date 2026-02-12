# Postis Shipment Status PWA

A full-stack mobile-first PWA for drivers to scan AWB barcodes and update shipment statuses in Postis.

## Features
- **Mobile-First PWA**: Installable on iOS/Android as a standalone app.
- **Offline Mode**: Local queue stores updates when connectivity is lost and syncs automatically when back online.
- **Barcode Scanning**: Integrated camera scanning with manual entry fallback.
- **Secure Backend**: FastAPI with JWT auth and Postis API integration.
- **Audit Logs**: Every update attempt is logged for full traceability.
- **Driver Management**: Load and sync driver credentials from a Google Sheet.

## Project Structure
```text
postis-pwa/
├── backend/            # FastAPI backend
│   ├── main.py        # Core API logic
│   ├── models.py      # SQLAlchemy DB models
│   ├── postis_client.py # Postis API wrapper
│   └── driver_manager.py # Google Sheets integration
├── frontend/           # React + Vite PWA
│   ├── src/
│   │   ├── pages/     # Screen components
│   │   ├── components/ # Shared UI components
│   │   └── store/     # Offline queue logic
│   └── public/        # PWA assets
└── README.md
```

## Setup Instructions

### Backend
1. Go to `backend` directory.
2. Create a virtual environment and install dependencies:
   ```bash
   pip install fastapi uvicorn sqlalchemy httpx pandas PyJWT pandas python-multipart
   ```
3. Copy `.env.example` to `.env` and fill in your credentials.
4. Run the server:
   ```bash
   uvicorn backend.main:app --reload
   ```

### Frontend
1. Go to `frontend` directory.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy `.env.example` to `.env` and set `VITE_API_URL`.
4. Run the dev server:
   ```bash
   npm run dev
   ```

## Postis Credentials
The app uses the following Postis authentication endpoint:
`https://shipments.postisgate.com/unauthenticated/login`

## Google Sheets Integration
Format your Google Sheet with the following columns:
`driver_id`, `name`, `username`, `password`, `role`, `active`

Ensure the sheet is accessible or use a CSV export URL.

## Admin Logs
Access logs via the `/logs` endpoint in the backend for auditing purposes.
