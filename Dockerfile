FROM node:22-bookworm-slim AS frontend
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM python:3.13-slim-bookworm
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt ./
RUN python -m pip install --no-cache-dir -r requirements.txt
RUN HF_HUB_DISABLE_IMPLICIT_TOKEN=1 HF_HUB_DISABLE_XET=1 HF_HUB_DISABLE_PROGRESS_BARS=1 \
    python -c "from faster_whisper.utils import download_model; download_model('tiny.en', output_dir='.models/tiny.en')"
COPY api/ api/
COPY --from=frontend /app/web/dist web/dist
USER 10001:10001
EXPOSE 10000
CMD ["sh", "-c", "exec python -m uvicorn api.main:app --host 0.0.0.0 --port ${PORT:-10000} --forwarded-allow-ips '*'"]
