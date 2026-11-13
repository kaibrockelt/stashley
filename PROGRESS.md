# Progress

**Current milestone:** M3 – Connections and table access (in review)

**Next step:** Review M3 in a fresh session before M4 starts. CI is green, including the integration job against the four database versions.

**Recommended model strength for M4:** strongest model, maximum effort.

## Milestones

| Milestone | Scope | Model strength | Status |
| --- | --- | --- | --- |
| M0 | Architecture plan | Strongest, maximum effort | Done |
| M1 | Scaffold and operations: monorepo, CI, Dockerfile, build script, metadata store, health, logs, backup and restore, i18n and design token foundations | Medium | Done |
| M2 | Sign-in and accounts: local accounts, sessions, CSRF, 2FA, OIDC with approval, system roles, profile, recovery CLI, audit log | High | Done |
| M3 | Connections and table access: database users, grant inspection, encryption, key rotation, schema introspection and diff, ceilings, column exclusions, virtual relations, display templates | High | In review |
| M4 | Queries, access control and cache: query library, SQL validation and execution, parameters, instance variables, roles, page and component rights, base filters, pagination, cache invalidation | Strongest, maximum effort | Open |
| M5 | Pages and dashboards: workspace shell, navigation, drafts and versions, grid, blocks, charts, query builder, SQL editor, preview as role | Medium (query builder: high) | Open |
| M6 | Forms and table pages: forms, generated fields, default values, foreign key selects, inline editing, deletion, optimistic locking, error translation, CSV export | Medium (write path and base filters: high) | Open |
| M7 | Public REST API and CSV import: endpoints, tokens, OpenAPI, imports including new tables | High | Open |
| M8 | MCP server: authorization server, metadata, tools, MCP exposure, privacy notice, call log | High | Open |
| M9 | Demo scenario and acceptance: seed script, configuration export and import, end-to-end suite, accessibility, performance, documentation, release pipeline | Medium (final review: high) | Open |

Status values: open, in progress, in review, done.

## Acceptance criteria

- [x] `docker compose up` with values from `.env.example` installs the instance, and the first admin can sign in.
- [x] The admin connects the demo database, gets a warning for the deliberately over-privileged user, and grants table access with the demo ceilings. (Schema and users exist; demo data and `scripts/seed-demo.sh` follow in M9.)
- [ ] The admin creates roles and test accounts. A first OIDC sign-in shows up as pending and gets approved.
- [ ] A manager builds every demo page through the UI alone, checks each one with preview as role, and publishes it.
- [ ] Every test account sees exactly the pages and components of its roles. Components without rights are absent from both the HTML and the API responses.
- [ ] Direct API calls outside a user's rights are rejected: a foreign component ID, extra payload fields, manipulated parameters. One hotel's front desk cannot read or change the other hotel's bookings, even with a manipulated ID.
- [ ] A manager cannot grant rights above a ceiling. Saving SQL with `UPDATE`, `DROP`, multiple statements or tables without table access is rejected.
- [ ] After the cashier records a payment, the payment status on the check-in and overview pages updates immediately, without waiting for the cache to expire.
- [ ] A station helper records a stamp on a 375 px phone in under 10 s. A duplicate stamp is rejected with a clear message.
- [ ] The route status page shows the 3 overdue participants with their phone numbers.
- [ ] The awards page lists exactly the 12 medal candidates. After `current_event_id` is switched to the 2025 event, every event-related page shows 2025 data.
- [ ] Every write appears in the audit log with its old and new values.
- [ ] The admin enables `list`, `get` and `create` for payments and creates a token with `create` only. A write through the API appears in the audit log, and `list` with that token returns `403`.
- [ ] The admin creates a new table from a CSV file encoded in Windows-1252, with semicolons and German dates, adding an `id` column. After the ceiling is adjusted, a second import upserts existing rows by `email`, and its dry run reports the faulty rows beforehand.
- [ ] The cashier connects an MCP client through OAuth and asks which registrations are still unpaid. The privacy notice appears before the connection and must be confirmed. The assistant receives only components of the cashier page whose tables are exposed to MCP. An admin account cannot set up MCP access.
- [ ] The configuration is exported and imported into a second instance. After the connection is mapped, the demo works there unchanged.
- [x] `scripts/build.sh --platform linux/amd64,linux/arm64` builds both architectures.
- [ ] The Playwright end-to-end suite covers all criteria above and runs in CI against the demo database.
- [ ] The UI is complete in English and German, with UI copy written specifically for the product.

## Deviations from the specification

All approved on 2026-11-12. Rationale for each is in [`docs/architecture.md` §28](docs/architecture.md#28-decisions-requiring-approval).

| ID | Approved deviation or interpretation |
| --- | --- |
| D1 | CSV is also used for the audit log export, the import error list and the CSV upload body, in addition to the table page export. |
| D2 | Single-row upserts use a locked lookup followed by `UPDATE` or `INSERT`, not `INSERT … ON DUPLICATE KEY UPDATE`. |
| D3 | SQL validation adds a function allowlist and rejects `@`/`@@` variables and executable comments. |
| D4 | In stored queries, `SELECT *` and `t.*` are allowed only on objects without excluded columns. |
| D5 | Invisible pages and components return `404` on the internal API. The public API returns `403` for operations a token lacks. |
| D6 | Public API: `POST` only creates, `PUT /:id` only replaces existing rows, `PUT /?on=<column>` is the idempotent upsert. `If-Match` is optional and enforced when sent. Unchanged repeats write nothing. |
| D7 | The row count estimate is used only for unfiltered requests on objects with more than 1,000,000 rows. |
| D8 | Additional libraries as listed in §28. The server uses the native Temporal API. |
| D9 | The runtime image is `node:26-slim`. |
| D10 | Writes to target databases are simulated in edit mode and preview: validation and `SELECT`-based checks, no DML. |
| D11 | Drafts are saved explicitly, and every save is audited. |
| D12 | Page filter options are authorized through the page's view right; option lists, lookup columns and display templates through the right of their component. |

Further decisions: QR codes for 2FA setup are rendered with `qrcode` (MIT), an addition to the D8 list; approving a pending account keeps its session, so the user can continue without signing in again; the common-password list is the subset of 12+ characters from SecLists (MIT). npm is removed from the runtime image; dependencies must be at least three days old (`minimumReleaseAge`); the compose host port is configurable with `STASHLEY_PORT`. Earlier decisions: documentation site with VitePress on GitHub Pages; problem types as `urn:stashley:problem:<code>`; images at `ghcr.io/kaibrockelt/stashley`.

## Log

- 2026-11-12: M0 started. The architecture plan is drafted.
- 2026-11-12: M0 approved, including D1–D12. D6 (public API write semantics) and D10 (simulated writes) were refined during the review. Brand artwork will be delivered: a hamster in comic style on a colored app icon tile.
- 2026-11-12: M1 implemented.
  - Verified locally: typecheck, lint, SPDX, i18n and license checks, 42 unit tests, bundle at 129 KB gzip (budget 300 KB).
  - `docker compose up` serves the web client, `/healthz` and `/readyz`. Backup, restore with the running-server guard, and graceful shutdown work.
  - The multi-arch build produces amd64 and arm64 images, both with native SQLite.
  - Trivy finds no critical issues. Two high findings in Debian's zlib wait for a base image update.
  - Not yet verified: the GitHub Actions run, which needs a push. Release and docs workflows are scheduled for M9.
- 2026-11-12: M1 done. The first GitHub Actions run on `9a25b20` is green (checks, multi-arch image, Trivy).
- 2026-11-13: M2 implemented.
  - Local sign-in, server-side sessions, CSRF, rate limits and account lockout.
  - TOTP with replay protection and recovery codes; 2FA can be enforced.
  - Invitations and password reset by email or copyable link.
  - OIDC sign-in with pending approval and auto-approved domains.
  - Admin pages for users, identity providers, settings and the audit log; profile with language, format, theme, password and 2FA.
  - Emergency CLI commands.
  - Verified with 58 server tests and in the browser against a mock OIDC provider (navikt/mock-oauth2-server): first OIDC sign-in shows as pending and is approved by an admin.
  - The OIDC part of the role criterion is met; roles themselves come with M4.
- 2026-11-13: M2 reviewed in a fresh session. Fixed:
  - Failed second-factor codes now count per account, across sessions and the 2FA settings routes.
  - A TOTP code works only once, even in parallel requests.
  - Invitation and reset tokens moved from URL paths to the fragment and request bodies, so they no longer appear in logs.
  - CSRF and origin checks use the matched route; requests without `Sec-Fetch-Site` and `Origin` are rejected.
  - Reset emails are limited per address and sent in the background.
  - Failed sign-ins are audited with a reason, including OIDC failures.
  - New CLI command `stashley user reset-mfa`.
  - While password sign-in is off, no change may leave the instance without an admin who can sign in.
  - Linking through `email_verified` stays as specified. Operators are responsible for connecting only providers that verify email addresses; the admin guide (M9) will say so.
  - Verified with 67 server tests and in the browser (invitation and password reset through fragment links).
- 2026-11-13: M3 implemented.
  - Connections with read, write and schema users; passwords encrypted per credential; TLS modes with optional CA; one pool per purpose with the session setup of §9.2; the self-connection guard pins the socket to the checked address.
  - Grant check from `SHOW GRANTS` with roles: required, missing and excess privileges per user. The deliberately over-privileged demo user gets warnings for FILE, PROCESS, INSERT, UPDATE, DELETE, DROP, ALTER and access to `mysql.*`.
  - Schema reading with keys, foreign keys, enum values and view base tables (MariaDB through the definition, MySQL through `VIEW_TABLE_USAGE`); diff, impact list, daily drift check.
  - Table access with ceilings, view key columns, column exclusions (all or MCP only), display templates with one relation step, API names and the MCP flag; virtual relations, also one-to-one into views.
  - `stashley rotate-key`, value encoding (§9.5) and admin pages for databases, sharing and relations.
  - Verified: 85 server unit tests; 40 integration tests against MariaDB 10.11 and 12.3 and MySQL 8.4 and 9.7 (the whole demo schema exposed with its ceilings, TLS on MySQL); a browser run against MariaDB 12.3 with the grant warning, sharing of a table and a view, and a schema change with its impact.
  - Decisions: the read user's required privileges include SHOW VIEW even for schemas without views; privileges of every granted role count, active or not, so warnings err on the safe side; a schema read stores a new snapshot only when the structure changed.
  - Not yet verified: the new CI integration job, which needs a push.
- 2026-11-13: CI fixed and green on `375ca1f`. The integration job had failed on `23685c6`: Vitest resolves test imports in its SSR environment, which ignored the `@stashley/source` condition, so `@stashley/shared` could not be found without a prior build. Checks, image and the integration job against MariaDB 10.11 and 12.3 and MySQL 8.4 and 9.7 now pass. M2 is done.

