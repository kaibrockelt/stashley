#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Stashley contributors
# SPDX-License-Identifier: AGPL-3.0-only
#
# Runs the Playwright end-to-end suite in Docker: builds the image, starts the environment of
# e2e/compose.yml (two instances, the demo database, a mock OIDC provider), runs the suite
# and removes every container, network and volume of it afterwards.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/test-e2e.sh [--no-build] [--keep] [-- <playwright arguments>]

  --no-build  Use the existing stashley:e2e image
  --keep      Leave the environment running afterwards (remove it with --down)
  --down      Remove the environment and stop
  -h, --help  Show this help

Workspace dependencies must be installed (pnpm install); the HTML report is written to
e2e/report.
USAGE
}

build=1
keep=0
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --no-build) build=0; shift ;;
    --keep) keep=1; shift ;;
    --down) docker compose -f "$(dirname "$0")/../e2e/compose.yml" down -v --remove-orphans; exit 0 ;;
    -h | --help) usage; exit 0 ;;
    --) shift; args=("$@"); break ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

root="$(cd "$(dirname "$0")/.." && pwd)"
compose=(docker compose -f "$root/e2e/compose.yml")

if [ "$build" = 1 ]; then
  docker build --tag "${STASHLEY_IMAGE:-stashley:e2e}" "$root"
fi

cleanup() {
  if [ "$keep" = 0 ]; then "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

"${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
"${compose[@]}" up -d --wait db oidc stashley-a stashley-b
"${compose[@]}" run --rm playwright npx playwright test ${args[@]+"${args[@]}"}
