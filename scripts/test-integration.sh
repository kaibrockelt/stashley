#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Stashley contributors
# SPDX-License-Identifier: AGPL-3.0-only
#
# Runs the target database tests locally against the oldest and newest supported
# MariaDB and MySQL versions, in Docker containers on published loopback ports.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/test-integration.sh [--stop]

Starts (or reuses) MariaDB 10.11 and 12.3 and MySQL 8.4 and 9.7 containers and runs
`pnpm --filter @stashley/server test:integration` against them.

  --stop      Remove the containers instead
  -h, --help  Show this help
USAGE
}

targets=(
  "mariadb-10.11|mariadb:10.11|33611"
  "mariadb-12.3|mariadb:12.3|33612"
  "mysql-8.4|mysql:8.4|33613"
  "mysql-9.7|mysql:9.7|33614"
)

case "${1:-}" in
  -h | --help)
    usage
    exit 0
    ;;
  --stop)
    for target in "${targets[@]}"; do
      IFS='|' read -r name _ _ <<<"$target"
      docker rm -f "stashley-it-${name}" >/dev/null 2>&1 || true
    done
    exit 0
    ;;
  "") ;;
  *)
    usage >&2
    exit 2
    ;;
esac

urls=()
for target in "${targets[@]}"; do
  IFS='|' read -r name image port <<<"$target"
  container="stashley-it-${name}"
  if [[ -z "$(docker ps -q --filter "name=^${container}$")" ]]; then
    docker rm -f "$container" >/dev/null 2>&1 || true
    docker run -d --name "$container" -p "127.0.0.1:${port}:3306" \
      -e MARIADB_ROOT_PASSWORD=root -e MYSQL_ROOT_PASSWORD=root "$image" >/dev/null
    echo "Started $container ($image) on port $port"
  fi
  urls+=("${name}=mysql://root:root@127.0.0.1:${port}")
done

# The databases are reached through loopback here, which the self-connection guard
# refuses; the test server relaxes it. CI runs the tests with the guard on.
STASHLEY_TEST_TARGETS="$(IFS=,; echo "${urls[*]}")" \
  STASHLEY_TEST_ALLOW_LOOPBACK=1 \
  pnpm --filter @stashley/server test:integration
