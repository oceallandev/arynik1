# Postis Shipment Status PWA

A full-stack mobile-first PWA for drivers to scan AWB barcodes and update shipment statuses in Postis.

## Live Data (No Dummy Data)
The online UI is served from the Vite build (`index.html`) on GitHub Pages. (`preview.html` is kept as a redirect for older links.) It does **not** use any dummy/mock data.

To see **live Postis data**, you must run/deploy the FastAPI backend and set the **API URL** in the app Settings to your backend base URL (must be **HTTPS** when using GitHub Pages).

If the backend is unreachable, the app falls back to the exported snapshot (read-only), backed by `data/shipments.json`.

## Features
- **Mobile-First PWA**: Installable on iOS/Android as a standalone app.
- **Offline Mode**: Local queue stores updates when connectivity is lost and syncs automatically when back online.
- **Barcode Scanning**: Integrated camera scanning with manual entry fallback.
- **Secure Backend**: FastAPI with JWT auth and Postis API integration.
- **Audit Logs**: Every update attempt is logged for full traceability.
- **Driver Management**: Load and sync driver credentials from a Google Sheet.

## Authentication Levels (RBAC)
The backend uses **roles** (stored on the user/driver) and enforces access via **permissions**.

### Roles (canonical)
- `Admin`: full access (users, drivers sync, shipments, labels, logs).
- `Manager`: operations manager (shipments, labels, status updates, all logs, can read users).
- `Dispatcher`: dispatcher (shipments, labels, status updates, all logs).
- `Warehouse`: warehouse staff (shipments, labels, status updates, own logs).
- `Driver`: courier/driver (status updates, single shipment by AWB, labels, own logs).
- `Support`: support (shipments, labels, all logs).
- `Finance`: finance (shipments, all logs).
- `Viewer`: read-only (shipments, labels, own logs).

### Romanian aliases accepted
The API normalizes common Romanian values to canonical roles:
- `Curier`, `Sofer`, `Șofer` -> `Driver`
- `Depozit` -> `Warehouse`
- `Dispecer` -> `Dispatcher`
- `Suport` -> `Support`
- `Financiar` -> `Finance`
- `Vizualizator` -> `Viewer`

### Useful endpoints
- `GET /me`: current user profile + computed permissions.
- `GET /roles`: list roles + permissions + accepted aliases.
- `GET /users` (permission: `users:read`): list users.
- `POST /users` (permission: `users:write`): create a user.
- `PATCH /users/{driver_id}` (permission: `users:write`): update role/active/password/etc.

### Google Sheet columns (users)
Format your Google Sheet with the following columns:
`driver_id`, `name`, `username`, `password`, `role`, `active`

Notes:
- `password` can be **plain text** or a **sha256 hex** (64 chars). It will be stored as sha256.
- `active` supports `TRUE/FALSE`, `1/0`, `yes/no`, `da/nu`.

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
1. Run from the **repo root** (recommended), or from within `backend/` (also supported).
2. Create a virtual environment and install dependencies:
   ```bash
   pip install -r backend/requirements.txt
   ```
3. Copy `backend/.env.example` to `backend/.env` and fill in your credentials (Postis + `DATABASE_URL`).
4. Seed an Admin user (default `admin` / `admin`) for first login:
   ```bash
   python seed_db.py
   ```
5. Run the server:
   ```bash
   # Option A (repo root):
   uvicorn backend.main:app --reload

   # Option B (from within backend/):
   # cd backend
   # uvicorn main:app --reload
   ```

Optional (recommended for live dashboards): enable automatic hourly Postis sync by setting `AUTO_SYNC_POSTIS=1`
in `backend/.env` (see `backend/.env.example`). If `AUTO_SYNC_POSTIS` is omitted entirely, the backend will
auto-enable sync when `POSTIS_USERNAME` and `POSTIS_PASSWORD` are present. This keeps the shipments DB updated
without manual pulls.

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
Ensure the sheet is accessible or use a CSV export URL.

## Admin Logs
Access logs via the `/logs` endpoint in the backend for auditing purposes.
