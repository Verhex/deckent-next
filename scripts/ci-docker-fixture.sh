#!/usr/bin/env bash
# Official node:24-trixie-slim, linux/amd64, Node 24.22.1 (lead inspection 2026-10-22, Node security release 2026-10-21).
# Pull by repository digest; tests require the resolved local image ID, not a mutable tag.
set -euo pipefail
: "${GITHUB_ENV:?GITHUB_ENV is required}"
image='node@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea'
trap 'echo "::error::Docker fixture preparation failed; required tests cannot run" >&2' ERR
git rev-parse HEAD
git --version
node --version
uname -srm
printf 'Runner image: %s %s\n' "${ImageOS:-unknown}" "${ImageVersion:-unknown}"
docker info --format '{{.ServerVersion}}'
docker pull --platform linux/amd64 "$image"
image_id=$(docker image inspect --format '{{.Id}}' "$image")
[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]]
[[ "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image_id")" == 'linux/amd64' ]]
# Match the worker's unprivileged, offline, read-only execution prerequisites.
docker run --rm --pull never --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --user "$(id -u):$(id -g)" \
  --pids-limit 64 --memory 256m --cpus 1 --tmpfs /tmp:rw,nosuid,nodev,size=16777216 \
  --entrypoint /bin/sh "$image_id" -ec \
  'test "$(node --version)" = v24.22.1; node -e '\''const fs=require("node:fs");fs.writeFileSync("/tmp/preflight","ok");if(fs.readFileSync("/tmp/preflight","utf8")!=="ok")process.exit(1)'\'''
printf 'DECKENT_TEST_DOCKER_IMAGE=%s\n' "$image_id" >> "$GITHUB_ENV"
printf 'Docker fixture ready: %s (%s)\n' "$image_id" "$image"
