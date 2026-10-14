# DeepTutor on a Hugging Face Docker Space.
#
# Reuses the official DeepTutor image for the Python backend and rebuilds only
# the web frontend from this fork (installable-app manifest + icons).
# SOURCE_REPO / SOURCE_REF are filled in by deploy.py with the exact commit.
ARG DEEPTUTOR_IMAGE=ghcr.io/hkuds/deeptutor:1.6.14

FROM node:22-slim AS web
ARG SOURCE_REPO=https://github.com/DeeJayKyle/DeepTutor.git
ARG SOURCE_REF=main
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates python3 python3-pil \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git init -q \
    && git remote add origin "$SOURCE_REPO" \
    && git fetch -q --depth 1 origin "$SOURCE_REF" \
    && git checkout -q FETCH_HEAD
COPY make_icons.py /tmp/make_icons.py
RUN python3 /tmp/make_icons.py web/public/logo.png web/public/icons
WORKDIR /src/web
RUN npm config set fetch-retries 5 \
    && npm ci --legacy-peer-deps \
    && printf 'NEXT_PUBLIC_APP_VERSION=\n' > .env.local \
    && npm run build

FROM ${DEEPTUTOR_IMAGE}
USER root
RUN rm -rf /app/web
COPY --from=web /src/web/.next/standalone/ /app/web/
COPY --from=web /src/web/.next/static/ /app/web/.next/static/
COPY --from=web /src/web/public/ /app/web/public/
RUN pip install --no-cache-dir "huggingface_hub>=0.30,<2" \
    && chown -R 1000:1000 /app/web /app/data
COPY --chmod=755 start.sh /app/hf/start.sh
COPY space_setup.py /app/hf/space_setup.py
# UID 1000 has no home directory in this image; keep the HF client cache writable.
ENV HF_HOME=/tmp/hf-home

# Hugging Face runs the container as UID 1000; DeepTutor's entrypoint supports that.
USER 1000
ENTRYPOINT ["/app/hf/start.sh"]
