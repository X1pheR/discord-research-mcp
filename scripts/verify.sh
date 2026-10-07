#!/bin/sh
set -eu

npm ci --ignore-scripts --no-audit --no-fund
npm test
npm audit --omit=dev --audit-level=high
python3 scripts/public-scrub.py
python3 scripts/verify-public-package.py

if command -v docker >/dev/null 2>&1; then
  if docker compose version >/dev/null 2>&1; then
    compose_json=$(mktemp)
    trap 'rm -f "$compose_json"' EXIT HUP INT TERM
    docker compose --env-file .env.example config --format json >"$compose_json"
    python3 scripts/verify-public-package.py --compose-json "$compose_json"
  fi
  docker build -t discord-research-mcp:verify .
fi
