ARG BASE_IMAGE
FROM ${BASE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates ripgrep python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY recipe.json install.mjs inspect.mjs /opt/deckent-worker/
RUN node /opt/deckent-worker/install.mjs
ENV HOME=/tmp/deckent-home
ENV DISABLE_AUTOUPDATER=1
WORKDIR /workspace
USER node
CMD ["node", "/opt/deckent-worker/inspect.mjs"]
