#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Stashley contributors
# SPDX-License-Identifier: AGPL-3.0-only
#
# Load test with k6 (in a container): 50 concurrent users against the first instance of the
# end-to-end environment, limited to 2 vCPU and 2 GB like the target hardware. Run it after
# `scripts/test-e2e.sh --keep`, which leaves the scenario set up; remove the environment
# afterwards with `scripts/test-e2e.sh --down`.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
container=stashley-e2e-stashley-a-1
network_owner=stashley-e2e-oidc-1

if ! docker container inspect "$container" >/dev/null 2>&1; then
  echo "The end-to-end environment is not running; start it with scripts/test-e2e.sh --keep." >&2
  exit 1
fi

docker update --cpus 2 --memory 2g --memory-swap 2g "$container" >/dev/null

ids=$(docker run --rm -v "$root/packages/demo:/demo:ro" -w /demo node:26-slim node --input-type=module -e "
import { demoId } from './src/scenario.ts'
for (const slug of ['uebersicht', 'kasse', 'anmeldungen', 'teilnehmer', 'station'])
  console.log('-e ID_' + slug.toUpperCase() + '=' + demoId('page:' + slug))
")

# shellcheck disable=SC2086
docker run --rm --network "container:$network_owner" \
  -v "$root/e2e/load:/load:ro" \
  -e BASE_URL=http://localhost:8080 \
  -e USER_PASSWORD='e2e user passphrase' \
  $ids \
  grafana/k6:1.4.2 run /load/scenario.js
