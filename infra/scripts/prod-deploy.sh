#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/opt/projects/post2cart-backend}"
BRANCH="${BRANCH:-main}"

cd "$PROJECT_DIR"

echo "==> git sync ($BRANCH)"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"

echo "==> docker compose up"
docker compose -f infra/docker-compose.prod.yml --env-file .env.production up -d --build

echo "==> containers"
docker compose -f infra/docker-compose.prod.yml ps

echo "==> backend health"
curl -fsS http://127.0.0.1:3010/ >/dev/null
echo "OK"
