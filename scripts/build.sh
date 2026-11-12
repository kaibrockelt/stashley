#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Stashley contributors
# SPDX-License-Identifier: AGPL-3.0-only
#
# Builds the Stashley image reproducibly from the current commit.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/build.sh [options]

  --platform <list>     Target platforms, e.g. linux/amd64,linux/arm64 (default: host)
  --push                Push the image (requires --registry)
  --registry <host/ns>  Registry and namespace, e.g. ghcr.io/kaibrockelt
  --no-cache            Build without the layer cache
  --allow-dirty         Build even with uncommitted changes
  --skip-checks         Skip typecheck, lint and unit tests
  -h, --help            Show this help
USAGE
}

platform=""
push=false
registry=""
no_cache=()
allow_dirty=false
skip_checks=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform) platform="${2:?--platform needs a value}"; shift 2 ;;
    --push) push=true; shift ;;
    --registry) registry="${2:?--registry needs a value}"; shift 2 ;;
    --no-cache) no_cache=(--no-cache); shift ;;
    --allow-dirty) allow_dirty=true; shift ;;
    --skip-checks) skip_checks=true; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")/.."

if [[ "$push" == true && -z "$registry" ]]; then
  echo "--push requires --registry" >&2
  exit 2
fi

if [[ "$allow_dirty" != true && -n "$(git status --porcelain)" ]]; then
  echo "Uncommitted changes. Commit them first, or pass --allow-dirty." >&2
  exit 1
fi

version="$(git describe --tags --always)"
revision="$(git rev-parse HEAD)"
branch="$(git rev-parse --abbrev-ref HEAD)"
# The commit time keeps labels and timestamps reproducible.
export SOURCE_DATE_EPOCH="$(git log -1 --format=%ct)"
created="$(date -u -r "$SOURCE_DATE_EPOCH" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$SOURCE_DATE_EPOCH" +%Y-%m-%dT%H:%M:%SZ)"

image="${registry:+$registry/}stashley"
tags=(--tag "$image:$version")
if [[ "$branch" == "main" ]]; then
  tags+=(--tag "$image:latest")
fi

platform_args=()
if [[ -n "$platform" ]]; then
  platform_args=(--platform "$platform")
fi

if [[ "$skip_checks" != true ]]; then
  echo "==> Checks (typecheck, lint, unit tests)"
  docker buildx build "${no_cache[@]}" --target check --progress plain .
fi

output=(--load)
if [[ "$push" == true ]]; then
  output=(--push --sbom=true --provenance=mode=max)
elif [[ "$platform" == *,* ]] && ! docker info --format '{{.DriverStatus}}' 2>/dev/null | grep -q 'io.containerd.snapshotter'; then
  # The classic image store cannot hold multi-platform images; build without loading.
  output=()
  echo "Note: multi-platform image is built but not loaded into the local image store."
fi

echo "==> Building $image:$version (${platform:-host platform})"
docker buildx build \
  "${no_cache[@]}" \
  "${platform_args[@]}" \
  "${tags[@]}" \
  "${output[@]}" \
  --build-arg "VERSION=$version" \
  --build-arg "REVISION=$revision" \
  --build-arg "CREATED=$created" \
  --target runtime \
  .

echo "==> Done: $image:$version"
