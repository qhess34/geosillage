# Panoramax Sequence Studio — image autonome (interface + API + ExifTool)

# 1. Interface (React + TypeScript), construite une fois
FROM node:22-bookworm-slim AS frontend
WORKDIR /src
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# 2. Exécution : Python + ExifTool (Ubuntu 24.04 : ExifTool 12.76, la version utilisée par les tests)
FROM ubuntu:24.04
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv libimage-exiftool-perl \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH
WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY backend/app backend/app
COPY --from=frontend /src/dist frontend/dist

# /data : projets (bases SQLite, miniatures) ; /photos : photos ; /exports : exports en mode copie
ENV PSS_DATA_DIR=/data \
    PSS_DEFAULT_DIR=/photos \
    HOME=/tmp \
    PYTHONUNBUFFERED=1
RUN mkdir -p /data /photos /exports && chmod 777 /data /exports
VOLUME ["/data"]
EXPOSE 8765
WORKDIR /app/backend
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/api/projects', timeout=4)" || exit 1
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8765"]
