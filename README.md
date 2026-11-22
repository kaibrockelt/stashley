# Stashley

Self-hosted dashboards, forms and table views on top of existing MariaDB and MySQL databases, delivered to users by role.

Documentation: admin guide, manager guide and API reference in [`docs/`](docs/) (published as a site). Progress and decisions: [`PROGRESS.md`](PROGRESS.md); design: [`docs/architecture.md`](docs/architecture.md).

## Quick start

Requirements: Docker with Compose.

```bash
cp .env.example .env
```

Set `APP_SECRET_KEY` (for example with `openssl rand -base64 32`) and `APP_BASE_URL` in `.env`, then:

```bash
docker compose up -d
```

Stashley listens on port 8080. Put a reverse proxy with TLS in front of it for anything but local use.

## Operations

| Task | Command |
| --- | --- |
| Back up the metadata store | `docker compose exec stashley stashley backup` |
| Restore a backup (server stopped) | `docker compose run --rm stashley restore /data/backups/<file>.db` |
| Health | `GET /healthz` (process), `GET /readyz` (metadata store and migrations) |

All state lives in the `/data` volume. Do not place it on a network filesystem (NFS, SMB).

## Development

Requirements: Node.js 26 and pnpm 12.

```bash
pnpm install
```

```bash
pnpm check
```

| Command | Purpose |
| --- | --- |
| `pnpm --filter @stashley/server dev` | Server with reload (needs `APP_SECRET_KEY`, `APP_BASE_URL`, `STASHLEY_DATA_DIR`) |
| `pnpm --filter @stashley/web dev` | Web client dev server, proxies API calls to port 8080 |
| `pnpm build` | Build all packages |
| `scripts/build.sh` | Build the Docker image |
| `scripts/seed-demo.sh` | Start a MariaDB container with the demo database (see `docs/demo.md`) |
| `scripts/test-integration.sh` | Target database tests against MariaDB 10.11 and 12.3, MySQL 8.4 and 9.7 |
| `scripts/test-e2e.sh` | Playwright end-to-end suite in Docker (two instances, demo database, mock OIDC provider), removed afterwards |
| `scripts/load-test.sh` | k6 load test, 50 users on 2 vCPU / 2 GB; run after `scripts/test-e2e.sh --keep` |
| `pnpm --filter @stashley/docs dev` | Documentation site |

## License

[GNU Affero General Public License v3.0 only](LICENSE).
