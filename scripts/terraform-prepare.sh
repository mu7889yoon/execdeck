#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cat >/dev/null

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required to build the Slidev site and Lambda package during terraform apply." >&2
  exit 1
fi

docker run --rm \
  --user "$(id -u):$(id -g)" \
  -e HOME=/tmp \
  -e npm_config_cache=/tmp/npm-cache \
  -v "$ROOT:/execdeck" \
  -w /execdeck \
  node:24-bookworm-slim \
  node scripts/terraform-prepare.ts
