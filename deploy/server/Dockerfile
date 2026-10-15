# Online DeepTutor server image (built by .github/workflows/server-image.yml).
#
# Reuses the official DeepTutor image for the Python backend and rebuilds only
# the web frontend from this repo (installable-app manifest + icons), then adds
# the cloud startup helpers. Build context: repository root.
ARG DEEPTUTOR_IMAGE=ghcr.io/hkuds/deeptutor:1.6.14

FROM node:22-slim AS web
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pil \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY deeptutor/__version__.py deeptutor/__version__.py
COPY web/package.json web/package-lock.json web/
RUN cd web \
    && npm config set fetch-retries 5 \
    && npm ci --legacy-peer-deps
COPY web/ web/
COPY deploy/server/make_icons.py /tmp/make_icons.py
RUN python3 /tmp/make_icons.py web/public/logo.png web/public/icons
RUN cd web \
    && printf 'NEXT_PUBLIC_APP_VERSION=\n' > .env.local \
    && npm run build

FROM ${DEEPTUTOR_IMAGE}
RUN rm -rf /app/web
COPY --from=web /src/web/.next/standalone/ /app/web/
COPY --from=web /src/web/.next/static/ /app/web/.next/static/
COPY --from=web /src/web/public/ /app/web/public/
RUN pip install --no-cache-dir "huggingface_hub>=0.30,<2" \
    && chown -R 1000:1000 /app/web
COPY --chmod=755 deploy/server/start.sh /app/cloud/start.sh
COPY deploy/server/cloud_setup.py /app/cloud/cloud_setup.py
# The runtime user has no home directory; keep the HF client cache writable.
ENV HF_HOME=/tmp/hf-home
ENTRYPOINT ["/app/cloud/start.sh"]
