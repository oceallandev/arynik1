# Postis Shipment Status PWA

A full-stack mobile-first PWA for drivers to scan AWB barcodes and update shipment statuses in Postis.

## Live Data (No Dummy Data)
The online UI is served from `preview.html` (GitHub Pages). It does **not** use any dummy/mock data.

To see **live Postis data**, you must run/deploy the FastAPI backend and set the **API URL** in the app Settings to your backend base URL (must be **HTTPS** when using GitHub Pages).

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
4. Seed an Admin user (default `admin` / `admin`) for first login:
   ```bash
   python seed_db.py
   ```
5. Run the server:
   ```bash
   uvicorn backend.main:app --reload
   ```

### Backend (Docker)
```bash
docker build -t arynik1 .
docker run -p 8000:8000 \\
  -e POSTIS_USERNAME=... \\
  -e POSTIS_PASSWORD=... \\
  -e JWT_SECRET=... \\
  arynik1
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
