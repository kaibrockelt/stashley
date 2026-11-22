# Installation

Stashley ships as one Docker image, `ghcr.io/kaibrockelt/stashley`, for `linux/amd64` and `linux/arm64`. Images are signed with cosign (keyless) and carry an SBOM and provenance attestations.

## Requirements

- Docker with Compose.
- A reverse proxy that terminates TLS and sets HSTS (for example Caddy, Traefik or nginx). Stashley speaks plain HTTP on port 8080 and refuses `http://` base URLs other than localhost.
- A volume for `/data` on a local disk. Do not put it on NFS or SMB: the metadata store is SQLite.
- For 50 concurrent users: 2 vCPU and 2 GB RAM.

## First start

```bash
cp .env.example .env
```

Set at least `APP_SECRET_KEY` (32 bytes or more, for example from `openssl rand -base64 32`), `APP_BASE_URL` and, for the first start, `INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD`. Then:

```bash
docker compose up -d
```

Sign in with the initial admin. The initial admin variables are read only while no admin exists; remove the password from `.env` afterwards.

::: warning Keep the secret key
`APP_SECRET_KEY` encrypts the database passwords and signs sessions. Without it, the stored passwords cannot be decrypted. Back it up separately from the data volume, and change it only with `stashley rotate-key` (see [Operations](/admin/operations)).
:::

## Health

| Endpoint | Meaning |
| --- | --- |
| `GET /healthz` | The process runs; used by the image's health check |
| `GET /readyz` | The metadata store is reachable and migrated |

Logs are JSON lines on stdout. Field values of target databases never appear in them, only in the audit log.
