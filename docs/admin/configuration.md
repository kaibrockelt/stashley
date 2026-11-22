# Configuration

Stashley is configured through environment variables only. Every secret can also be read from a file by adding `_FILE` to its name, for example `APP_SECRET_KEY_FILE=/run/secrets/stashley_secret_key` with Docker secrets.

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_SECRET_KEY` | required | Encryption of stored database passwords and session signatures; at least 32 bytes |
| `APP_BASE_URL` | required | Public URL; https unless the host is localhost. Used for OIDC callbacks and links in emails |
| `INITIAL_ADMIN_EMAIL`, `INITIAL_ADMIN_PASSWORD` | – | First admin, while no admin exists |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | – | Email for invitations and password resets. Without SMTP, admins copy the links |
| `TRUST_PROXY` | – | Addresses or CIDRs of reverse proxies allowed to set `X-Forwarded-*` |
| `APP_TIMEZONE` | `UTC` | Time zone in which dates and times are shown and date expressions (`now`, `today`) are evaluated |
| `CACHE_MAX_MB` | `256` | Size of the query cache |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |
| `STASHLEY_PUBLIC_API` | `on` | `off` leaves the REST API unregistered |
| `STASHLEY_IMPORT_CONCURRENCY` | `2` | CSV imports running at once per instance |
| `STASHLEY_IMPORT_PER_USER` | `1` | CSV imports running at once per user |
| `STASHLEY_IMPORT_MAX_MB` | `50` | Largest CSV upload |
| `STASHLEY_IMPORT_BATCH_SIZE` | `500` | Rows per insert batch |
| `STASHLEY_PORT` | `8080` | Host port in `docker-compose.yml` |

Settings that admins change at run time (password sign-in, enforced two-factor authentication, session lengths, audit retention, whether managers may create roles) live in **Administration → Settings**.

## Reverse proxy

Terminate TLS at the proxy, send HSTS from there and pass `X-Forwarded-For` and `X-Forwarded-Proto`. Set `TRUST_PROXY` to the proxy's address; otherwise rate limits count every request against the proxy's address, and the log warns once when forwarded headers arrive. Stashley sets its own Content Security Policy, `X-Content-Type-Options`, `Referrer-Policy` and `frame-ancestors 'none'`.
