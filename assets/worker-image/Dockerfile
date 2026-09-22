# deckent/worker image version history (newest first). One line per version, machine-checked by build.mjs:
# version <id> | <date> | base <image> | supersedes <id|none> | <reason>
# Resolved provider versions and the immutable imageId live in the build receipt (worker-images/<version>.json).
# Older receipts are archived under worker-images/archive/; older images and tags are retained, never deleted here.
# version r2-20260922 | 2026-09-22 | base node:24-trixie-slim | supersedes r1-20260921 | Claude safe-mode/settings flags; OCI labels; history copied into the image
# version r1-20260921 | 2026-09-21 | base node:24-trixie-slim | supersedes none | first Next three-provider image; built untagged, sources unverified in receipt; tagged retroactively and archived
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG BASE_IMAGE
ARG IMAGE_VERSION
ARG RECIPE_SHA256
ARG SOURCE_REVISION
LABEL org.opencontainers.image.title="deckent/worker" \
      org.opencontainers.image.version="${IMAGE_VERSION}" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      org.opencontainers.image.base.name="${BASE_IMAGE}" \
      dev.deckent.worker.recipe.sha256="${RECIPE_SHA256}"
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates ripgrep python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY Dockerfile recipe.json install.mjs inspect.mjs /opt/deckent-worker/
RUN node /opt/deckent-worker/install.mjs
ENV HOME=/tmp/deckent-home
ENV DISABLE_AUTOUPDATER=1
WORKDIR /workspace
USER node
CMD ["node", "/opt/deckent-worker/inspect.mjs"]
