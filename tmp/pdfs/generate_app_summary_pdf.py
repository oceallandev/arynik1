from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.pdfbase.pdfmetrics import stringWidth

OUT_PATH = "output/pdf/arynik1-app-summary-one-page.pdf"
PAGE_W, PAGE_H = A4
MARGIN = 36
MAX_W = PAGE_W - 2 * MARGIN

TITLE_FONT = "Helvetica-Bold"
HEAD_FONT = "Helvetica-Bold"
BODY_FONT = "Helvetica"


def wrap_text(text: str, font: str, size: int, max_width: float):
    words = str(text or "").split()
    if not words:
        return [""]
    lines = []
    current = words[0]
    for word in words[1:]:
        trial = f"{current} {word}"
        if stringWidth(trial, font, size) <= max_width:
            current = trial
        else:
            lines.append(current)
            current = word
    lines.append(current)
    return lines


class OnePageWriter:
    def __init__(self, c: canvas.Canvas):
        self.c = c
        self.y = PAGE_H - MARGIN

    def need_space(self, amount: float):
        if self.y - amount < MARGIN:
            raise RuntimeError("Content exceeds one page; reduce copy.")

    def title(self, text: str):
        size = 20
        self.need_space(30)
        self.c.setFont(TITLE_FONT, size)
        self.c.drawString(MARGIN, self.y, text)
        self.y -= 26
        self.c.setStrokeColorRGB(0.72, 0.72, 0.72)
        self.c.setLineWidth(0.8)
        self.c.line(MARGIN, self.y, PAGE_W - MARGIN, self.y)
        self.y -= 10

    def section(self, heading: str):
        self.need_space(22)
        self.c.setFont(HEAD_FONT, 12)
        self.c.drawString(MARGIN, self.y, heading)
        self.y -= 16

    def paragraph(self, text: str):
        size = 10
        line_h = 13
        lines = wrap_text(text, BODY_FONT, size, MAX_W)
        self.need_space(line_h * len(lines) + 6)
        self.c.setFont(BODY_FONT, size)
        for line in lines:
            self.c.drawString(MARGIN, self.y, line)
            self.y -= line_h
        self.y -= 5

    def bullet(self, text: str):
        size = 10
        line_h = 13
        bullet = "-"
        bullet_w = stringWidth(f"{bullet} ", BODY_FONT, size)
        wrapped = wrap_text(text, BODY_FONT, size, MAX_W - bullet_w)
        self.need_space(line_h * len(wrapped) + 3)
        self.c.setFont(BODY_FONT, size)
        self.c.drawString(MARGIN, self.y, bullet)
        self.c.drawString(MARGIN + bullet_w, self.y, wrapped[0])
        self.y -= line_h
        for line in wrapped[1:]:
            self.c.drawString(MARGIN + bullet_w, self.y, line)
            self.y -= line_h
        self.y -= 2


content = {
    "what_is": (
        "Postis Shipment Status PWA is a mobile-first delivery operations app for scanning AWB labels "
        "and updating shipment statuses. The repo implements a React/Vite installable PWA frontend and a "
        "FastAPI backend that authenticates users and integrates with Postis APIs."
    ),
    "who_for": (
        "Primary persona: courier/driver who scans parcels and submits field status updates. "
        "Secondary personas in RBAC: Admin, Manager, Dispatcher, Warehouse, Support, Finance, Viewer, Recipient."
    ),
    "features": [
        "AWB scanning with camera barcode/QR detection plus manual entry fallback.",
        "Status update workflows that call secured backend endpoints (/update-awb, /shipments/update-status).",
        "Offline-first queue in IndexedDB with automatic re-sync when connectivity returns.",
        "Role-based access control with JWT sessions and permission-gated screens/endpoints.",
        "Operations modules for manifests, route plans/runs, live driver location, tracking requests, and chat.",
        "Snapshot fallback mode when backend is unreachable, with API auto-detect from Settings.",
    ],
    "architecture": [
        "Client layer: React + Vite + HashRouter PWA (frontend/src/main.jsx, frontend/src/App.jsx, frontend/vite.config.js).",
        "Client services: centralized API client and data-source switching (frontend/src/services/api.js) plus offline queue (frontend/src/store/queue.js).",
        "API layer: FastAPI app with OAuth2/JWT auth, CORS, and permission checks (backend/main.py, backend/authz.py).",
        "Data layer: SQLAlchemy models/session (backend/models.py, backend/database.py); defaults to SQLite locally and supports Postgres via DATABASE_URL.",
        "Integration layer: Postis client for auth/tracking/status updates and background Postis sync loop (backend/postis_client.py, backend/services/postis_sync_service.py).",
        "Data flow: scan AWB -> frontend sends or queues update -> backend validates role and logs -> backend updates DB and calls Postis -> UI reflects sync/result state.",
    ],
    "run_steps": [
        "Install backend deps from repo root: pip install -r backend/requirements.txt.",
        "Create backend/.env from .env.example and set at least POSTIS_USERNAME, POSTIS_PASSWORD, DATABASE_URL, and JWT_SECRET.",
        "Seed initial admin and run API: python seed_db.py then uvicorn backend.main:app --reload.",
        "Start frontend: cd frontend && npm install; set VITE_API_URL in .env; then run npm run dev."
    ],
    "missing": "Not found in repo: a dedicated architecture diagram; architecture above is code-derived.",
    "evidence": (
        "Evidence files: README.md, backend/main.py, backend/authz.py, backend/models.py, backend/database.py, "
        "backend/postis_client.py, backend/services/postis_sync_service.py, frontend/src/main.jsx, "
        "frontend/src/App.jsx, frontend/src/services/api.js, frontend/src/store/queue.js, frontend/vite.config.js, render.yaml"
    ),
}

c = canvas.Canvas(OUT_PATH, pagesize=A4)
writer = OnePageWriter(c)

writer.title("Arynik1 App Summary (Repo-Based, One Page)")

writer.section("What It Is")
writer.paragraph(content["what_is"])

writer.section("Who It Is For")
writer.paragraph(content["who_for"])

writer.section("What It Does")
for item in content["features"]:
    writer.bullet(item)

writer.section("How It Works (Architecture)")
for item in content["architecture"]:
    writer.bullet(item)

writer.section("How To Run (Minimal)")
for step in content["run_steps"]:
    writer.bullet(step)

writer.section("Missing Info")
writer.paragraph(content["missing"])

writer.section("Repo Evidence")
writer.paragraph(content["evidence"])

# Footer
writer.need_space(12)
c.setFont(BODY_FONT, 8)
c.drawRightString(PAGE_W - MARGIN, MARGIN - 6, "Generated from local repo evidence only")

c.showPage()
c.save()
print(OUT_PATH)
