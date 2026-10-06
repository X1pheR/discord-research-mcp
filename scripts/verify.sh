#!/bin/sh
set -eu

npm ci --ignore-scripts --no-audit --no-fund
npm test
python3 scripts/public-scrub.py

if command -v docker >/dev/null 2>&1; then
  if docker compose version >/dev/null 2>&1; then
    docker compose --env-file .env.example config -q
  fi
  docker build -t discord-research-mcp:verify .
fi
