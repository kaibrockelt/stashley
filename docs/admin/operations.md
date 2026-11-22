# Backup, upgrades and keys

## What to back up

| What | Where | How |
| --- | --- | --- |
| Metadata store (configuration, accounts, audit log) | `/data/stashley.db` | `stashley backup` |
| Secret key | `APP_SECRET_KEY` | Store it separately, for example in a password manager |
| Target databases | your MariaDB/MySQL servers | Your usual database backups; Stashley does not back them up |

```bash
docker compose exec stashley stashley backup
```

writes a consistent online backup to `/data/backups/`. Restore with the server stopped:

```bash
docker compose stop stashley
docker compose run --rm stashley restore /data/backups/<file>.db
docker compose start stashley
```

## Upgrades

Pull the new image and start it. Pending migrations of the metadata store run at start, and a copy of the store is written to `/data/backups` before each migration.

```bash
docker compose pull && docker compose up -d
```

Read the [changelog](/CHANGELOG) first. Releases follow semantic versioning; while the version starts with 0, minor releases may change behavior.

Verify a release image's signature with cosign:

```bash
cosign verify ghcr.io/kaibrockelt/stashley:0.1.0 \
  --certificate-identity-regexp 'https://github.com/kaibrockelt/stashley/.github/workflows/release.yml@refs/tags/v.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## Changing the secret key

```bash
docker compose stop stashley
openssl rand -base64 32 > new-key
docker compose run --rm -v "$PWD/new-key:/run/new-key:ro" stashley rotate-key --new-key-file /run/new-key
```

Then put the new key into `APP_SECRET_KEY` and start again. All sessions end. Backups made before the rotation still need the old key.
