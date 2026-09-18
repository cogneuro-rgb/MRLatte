# MRLatte single-image deploy: build the React app, then serve it + the FastAPI
# API from one uvicorn process on port 8001 (same origin → no CORS in prod).

# ---- Stage 1: build the frontend ---------------------------------------------
FROM node:20-bullseye AS frontend
WORKDIR /fe
COPY frontend/package.json frontend/yarn.lock ./
RUN yarn install --frozen-lockfile --network-timeout 600000
COPY frontend/ ./
# Same-origin API calls in the production bundle (overrides dev .env).
ENV REACT_APP_BACKEND_URL=""
RUN yarn build

# ---- Stage 2: backend runtime that serves the build --------------------------
FROM python:3.11-slim AS runtime
# dcm2niix enables the DICOM import endpoint (optional but cheap to include).
RUN apt-get update \
    && apt-get install -y --no-install-recommends dcm2niix \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

# Backend code + offline scripts (server.py references /app/scripts/... paths).
COPY backend/ ./backend/
COPY tools/scripts/ ./scripts/
# Built frontend (served as static at '/').
COPY --from=frontend /fe/build ./frontend/build
# Atlases now live outside the frontend tree (data/modules/atlases), so they no
# longer ride along with the CRA public/ build output — copy them in explicitly.
COPY data/modules/atlases ./frontend/build/atlases

ENV STATIC_DIR=/app/frontend/build \
    LESION_DIR=/data/lesions \
    ATLAS_DIR=/app/frontend/build/atlases \
    PYTHONUNBUFFERED=1

WORKDIR /app/backend
EXPOSE 8001
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8001"]
