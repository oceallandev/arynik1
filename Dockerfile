FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

# Install backend dependencies
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

# App code
COPY backend backend
COPY seed_db.py seed_db.py

# Optional static assets (backend can serve them, but GitHub Pages hosts the UI)
COPY preview.html preview.html
COPY index.html index.html
COPY logo.png logo.png

ENV PORT=8000

CMD ["sh", "-c", "uvicorn backend.main:app --host 0.0.0.0 --port ${PORT:-8000}"]

