#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Stashley contributors
# SPDX-License-Identifier: AGPL-3.0-only
#
# Starts a MariaDB container with the demo database `wanderverein`: schema, views, database
# users and deterministic demo data, with the 2026 event taking place today at 14:30.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/seed-demo.sh [options]

Starts (or reuses) a MariaDB container, creates the demo database `wanderverein` from
scratch and prints the connection details for Stashley.

  --name <name>        Container name (default: stashley-demo-db)
  --image <image>      Database image (default: mariadb:12.3)
  --port <port>        Host port on 127.0.0.1, or "none" (default: 3307)
  --network <network>  Docker network to attach the container to (created if missing)
  --root-password <pw> Root password of a new container (default: stashley-demo-root)
  --now <instant>      Treat this ISO 8601 instant as now (default: the current time)
  --remove             Remove the container and stop
  -h, --help           Show this help

An existing container with the given name is reused; its `wanderverein` database is
dropped and created again. The demo users' passwords are for local demos only.
USAGE
}

name=stashley-demo-db
image=mariadb:12.3
port=3307
network=''
root_password=stashley-demo-root
now=''
remove=0

while [ $# -gt 0 ]; do
  case "$1" in
    --name) name="$2"; shift 2 ;;
    --image) image="$2"; shift 2 ;;
    --port) port="$2"; shift 2 ;;
    --network) network="$2"; shift 2 ;;
    --root-password) root_password="$2"; shift 2 ;;
    --now) now="$2"; shift 2 ;;
    --remove) remove=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

root="$(cd "$(dirname "$0")/.." && pwd)"
demo="$root/packages/demo"

if [ "$remove" = 1 ]; then
  docker rm -f "$name" >/dev/null 2>&1 || true
  echo "Removed $name."
  exit 0
fi

# The generator is TypeScript; Node 23.6 and later run it directly. Otherwise it runs in a
# throwaway Node container.
generate() {
  local args=("$@")
  if [ -n "$now" ]; then args+=(--now "$now"); fi
  if command -v node >/dev/null 2>&1 &&
    [ "$(node -p 'Number(process.versions.node.split(".")[0])')" -ge 24 ]; then
    node "$demo/src/cli.ts" "${args[@]}"
  else
    docker run --rm -v "$demo:/demo:ro" -w /demo node:26-slim node src/cli.ts "${args[@]}"
  fi
}

if [ -n "$network" ] && ! docker network inspect "$network" >/dev/null 2>&1; then
  docker network create "$network" >/dev/null
fi

if docker container inspect "$name" >/dev/null 2>&1; then
  if [ "$(docker container inspect -f '{{.State.Running}}' "$name")" != true ]; then
    docker start "$name" >/dev/null
  fi
  # Reused containers keep their own root password.
  root_password="$(docker container inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$name" |
    grep -E '^(MARIADB|MYSQL)_ROOT_PASSWORD=' | head -n 1 | cut -d= -f2-)"
  if [ -z "$root_password" ]; then
    echo "Cannot read the root password of $name." >&2
    exit 1
  fi
else
  publish=()
  if [ "$port" != none ]; then publish=(-p "127.0.0.1:$port:3306"); fi
  docker run -d --name "$name" ${network:+--network "$network"} ${publish[@]+"${publish[@]}"} \
    -e MARIADB_ROOT_PASSWORD="$root_password" -e MYSQL_ROOT_PASSWORD="$root_password" "$image" >/dev/null
fi

# MariaDB images ship `mariadb`, MySQL images `mysql`.
client=mariadb
if ! docker exec "$name" sh -c 'command -v mariadb' >/dev/null 2>&1; then client=mysql; fi
sql() { docker exec -i -e MYSQL_PWD="$root_password" "$name" "$client" -uroot "$@"; }

printf 'Waiting for %s ' "$name"
for _ in $(seq 1 90); do
  if sql -e 'SELECT 1' >/dev/null 2>&1; then break; fi
  printf '.'
  sleep 1
done
echo
sql -e 'SELECT 1' >/dev/null

sql -e 'DROP DATABASE IF EXISTS wanderverein; CREATE DATABASE wanderverein CHARACTER SET utf8mb4'
sql wanderverein <"$demo/sql/schema.sql"
sql wanderverein <"$demo/sql/users.sql"
generate data | sql wanderverein

check="$(generate verify)"
failed="$(sql --skip-column-names wanderverein -e "SET time_zone = '+00:00'; $check")"
if [ -n "$failed" ]; then
  echo "The demo data does not meet these checks: $failed" >&2
  exit 1
fi

host=127.0.0.1
db_port="$port"
if [ "$port" = none ]; then
  host="$name"
  db_port=3306
fi
cat <<INFO
Demo database ready in container $name ($image).

  Host       $host${network:+ (or $name on the Docker network $network)}
  Port       $db_port
  Database   wanderverein
  Time zone  UTC

  Read user     stashley_read / demo-read-password
  Write user    stashley_write / demo-write-password
  Schema user   stashley_schema / demo-schema-password
  Over-privileged user for the grant warning: stashley_zuviel / demo-zuviel-password

Stashley refuses loopback addresses. When Stashley runs in Docker, attach both containers
to one network (--network) and connect to $name:3306.
INFO
