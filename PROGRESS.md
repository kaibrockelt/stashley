# Progress

**Current milestone:** M9 – Demo scenario and acceptance (in review); M8 moved after the MVP (D17)

**Next step:** Final review of M9 in a fresh session (high effort); then push, let CI run the e2e job, rename the changelog's `[Unreleased]` to `[0.1.0]` and tag `v0.1.0`.

**Recommended model strength:** M9: medium (final review: high).

The SQL validation of M4 is tested externally; that does not block M6.

## Milestones

| Milestone | Scope | Model strength | Status |
| --- | --- | --- | --- |
| M0 | Architecture plan | Strongest, maximum effort | Done |
| M1 | Scaffold and operations: monorepo, CI, Dockerfile, build script, metadata store, health, logs, backup and restore, i18n and design token foundations | Medium | Done |
| M2 | Sign-in and accounts: local accounts, sessions, CSRF, 2FA, OIDC with approval, system roles, profile, recovery CLI, audit log | High | Done |
| M3 | Connections and table access: database users, grant inspection, encryption, key rotation, schema introspection and diff, ceilings, column exclusions, virtual relations, display templates | High | Done |
| M4 | Queries, access control and cache: query library, SQL validation and execution, parameters, instance variables, roles, page and component rights, base filters, pagination, cache invalidation | Strongest, maximum effort | Done |
| M5 | Pages and dashboards: workspace shell, navigation, drafts and versions, grid, blocks, charts, query builder, SQL editor, preview as role | Medium (query builder: high) | Done |
| M6 | Forms and table pages: forms, generated fields, default values, foreign key selects, inline editing, deletion, optimistic locking, error translation, CSV export; column limits for the write user's `INSERT` and `UPDATE` (review first, see log 2026-11-15) | Medium (write path and base filters: high) | Done |
| M7 | Public REST API and CSV import: endpoints, tokens, OpenAPI, imports including new tables | High (new tables, review: extra high) | Done |
| M8 | MCP server: authorization server, metadata, tools, MCP exposure, privacy notice, call log | High (authorization server and its review: extra high) | After the MVP (D17) |
| M9 | Demo scenario and acceptance: seed script, configuration export and import, end-to-end suite, accessibility, performance, documentation, release pipeline; MCP controls hidden until M8 (D17) | Medium (final review: high) | In review |

Status values: open, in progress, in review, done, after the MVP.

## Acceptance criteria

- [x] `docker compose up` with values from `.env.example` installs the instance, and the first admin can sign in.
- [x] The admin connects the demo database, gets a warning for the deliberately over-privileged user, and grants table access with the demo ceilings. (M9: through the UI in e2e spec 02, with the demo data of `scripts/seed-demo.sh`.)
- [x] The admin creates roles and test accounts. A first OIDC sign-in shows up as pending and gets approved. (e2e spec 04.)
- [ ] A manager builds every demo page through the UI alone, checks each one with preview as role, and publishes it. (M9 in part: e2e spec 17 builds four pages through the UI covering every block type and mechanism — query tables, forms with hidden defaults from a variable and a fixed value, a table page with a base filter over a relation and inline editing, metrics and charts from the suggested setup, a page filter feeding a form — and previews and publishes each; all eleven pages come in through the demo configuration import. For the final review to decide.)
- [x] Every test account sees exactly the pages and components of its roles. Components without rights are absent from both the HTML and the API responses. (e2e spec 05.)
- [x] Direct API calls outside a user's rights are rejected: a foreign component ID, extra payload fields, manipulated parameters. One hotel's front desk cannot read or change the other hotel's bookings, even with a manipulated ID. (e2e spec 06.)
- [x] A manager cannot grant rights above a ceiling. Saving SQL with `UPDATE`, `DROP`, multiple statements or tables without table access is rejected. (e2e spec 07, in the editor and through the API.)
- [x] After the cashier records a payment, the payment status on the check-in and overview pages updates immediately, without waiting for the cache to expire. (e2e spec 08.)
- [x] A station helper records a stamp on a 375 px phone in under 10 s. A duplicate stamp is rejected with a clear message. (e2e spec 09, project `mobile`.)
- [x] The route status page shows the 3 overdue participants with their phone numbers. (e2e spec 10.)
- [x] The awards page lists exactly the 12 medal candidates. After `current_event_id` is switched to the 2025 event, every event-related page shows 2025 data. (e2e spec 11.)
- [x] Every write appears in the audit log with its old and new values. (e2e spec 12.)
- [x] The admin enables `list`, `get` and `create` for payments and creates a token with `create` only. A write through the API appears in the audit log, and `list` with that token returns `403`. (M7; e2e spec 13.)
- [x] The admin creates a new table from a CSV file encoded in Windows-1252, with semicolons and German dates, adding an `id` column. After the ceiling is adjusted, a second import upserts existing rows by `email`, and its dry run reports the faulty rows beforehand. (M7; e2e spec 14.)
- [ ] (After the MVP, D17.) The cashier connects an MCP client through OAuth and asks which registrations are still unpaid. The privacy notice appears before the connection and must be confirmed. The assistant receives only components of the cashier page whose tables are exposed to MCP. An admin account cannot set up MCP access.
- [x] The configuration is exported and imported into a second instance. After the connection is mapped, the demo works there unchanged. (e2e spec 15.)
- [x] `scripts/build.sh --platform linux/amd64,linux/arm64` builds both architectures.
- [x] The Playwright end-to-end suite covers all criteria above and runs in CI against the demo database. (34 tests green locally; the CI job `e2e` has not run yet, it needs a push.)
- [x] The UI is complete in English and German, with UI copy written specifically for the product. (i18n check; e2e spec 16.)

## Deviations from the specification

D1–D12 approved on 2026-11-12, D13–D16 on 2026-11-14, D17 on 2026-11-22. Rationale for D1–D12 for each is in [`docs/architecture.md` §28](docs/architecture.md#28-decisions-requiring-approval).

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
| D13 | Date-time parameters arrive as UTC instants and are bound as wall times of the connection time zone, like written values (§9.5). (Approved 2026-11-14.) |
| D14 | When managers may not create roles, only admins create, rename or delete roles; managers still grant rights to existing roles. (Approved 2026-11-14.) |
| D15 | Grants to deleted roles stop taking effect and show as a warning on the page; stored pages are not rewritten, and the page settings remove deleted roles in one step. (Approved 2026-11-14; warning instead of error since the M5 review.) |
| D16 | The SQL lexer rejects locking clauses (`FOR UPDATE`, `FOR SHARE`, `LOCK IN SHARE MODE`) itself, because the MariaDB parser does not know all of them and the error must stay specific. (Approved 2026-11-14.) |
| D17 | The MCP server (M8) moves after the MVP, and with it its acceptance criterion: an OAuth 2.1 authorization server with client registration through fetched metadata documents, consent within the sign-in, versioned notices and data leaving to AI providers make it a large milestone with new security questions. The MCP flags and exclusions of table access and the MCP setting of pages stay in the data model; their controls are hidden until M8 (in M9). (Approved 2026-11-22.) |

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

- 2026-11-13: M3 reviewed in a fresh session: 3 blocking, 8 should-fix and 18 nice-to-have findings. Fixed so far:
  - Stored database passwords are reused only while host, port and TLS settings stay the same. With any other target, every password must be entered again, so a test can no longer send them to a different server. A test that uses stored passwords is audited as `connection.tested`.
  - The self-connection guard normalizes addresses first, so IPv4-mapped IPv6 such as `::ffff:7f00:1` no longer reaches loopback. Only public, private and carrier-grade NAT IPv4, global unicast and unique local IPv6 are allowed. `ipaddr.js` (D8) is now a direct dependency.
  - Role grants are read on MariaDB as well: it refuses `SHOW GRANTS FOR <role>` for inactive roles, so each role is read after `SET ROLE`. `PUBLIC` grants on MariaDB 11.1 and later count too.
  - Missing and granted privileges now come only from roles active at sign-in, because Stashley never runs `SET ROLE`. Other granted roles still produce warnings, plus `inactive_role`. This replaces the earlier decision that every granted role counts.
  - Route tests for all data routes: roles, CSRF, validation, guard and rate limit.
  - Verified with 94 server unit tests and 52 integration tests against MariaDB 10.11 and 12.3 and MySQL 8.4 and 9.7.
  - Open: the should-fix findings S1–S8.
- 2026-11-13: M3 review, should-fix findings fixed:
  - MariaDB's global `WITH GRANT OPTION`, written after the authentication clause, is detected again.
  - The default display template skips excluded columns. A stored template that breaks later (a column excluded or removed, the target unshared) is flagged `template_invalid` and not used; the default takes its place.
  - JSON values stay raw text (`jsonStrings`).
  - The catalog marks only virtual and stored columns as generated (not MySQL's `DEFAULT_GENERATED`) and records `ON UPDATE`.
  - A table replaced by a view of the same name becomes read-only view access, audited and listed in the impact as `type_changed`. Tables whose primary key no longer matches the key column get `key_mismatch`.
  - A pool that cannot reach its pinned address resolves the host again on the next request; IPv4 addresses come first.
  - Snapshots of unacknowledged drifts are no longer pruned, so those drifts stay.
  - Verified with 103 server unit tests and 72 integration tests against MariaDB 10.11 and 12.3 and MySQL 8.4 and 9.7.
  - Open: the review's nice-to-have findings.
- 2026-11-13: M3 review, nice-to-have findings fixed:
  - Grants:
    - MySQL partial revokes are taken off global privileges.
    - `WITH ADMIN OPTION` on roles is a warning.
    - Update and delete need SELECT for the write user.
    - The read user needs only SELECT; SHOW VIEW is checked per exposed view, which shows `view_dependencies_unknown` when the view's base tables are unknown. This replaces the decision to always require SHOW VIEW.
  - Catalog:
    - Prefix and functional indexes no longer count as unique keys.
    - View base tables leave out CTE names and unknown objects.
    - Every schema read stores its outcome on the connection (migration `0004_schema_check`), so a failed daily check shows on the connection page.
    - The writes of a schema read run in one transaction.
  - Table access:
    - A nullable view key shows `view_key_nullable`.
    - Relations need matching value kinds.
    - A view key used by a relation cannot change.
    - A display template naming a source column with two targets must name the target.
    - Listing table access no longer decrypts passwords.
  - Runtime:
    - Concurrent first requests share one pool.
    - A failed call rolls back before its connection is reused.
    - Impossible legacy dates are flagged instead of failing.
    - Hosts may contain underscores.
    - The connection dialog warns when TLS does not verify the certificate.
    - `rotate-key` reminds that the backup still holds the old key.
  - Tests check that rotation covers every column holding a ciphertext, and that a failed rotation changes nothing.
  - Carried forward:
    - `KILL QUERY` on a client timeout (§9.2) belongs to the M4 execution path.
    - Column-level write grants limit writable fields in M6.
    - The default API alias equals the table name, while the requirements say the real table name is not disclosed. M7 decides whether enabling an endpoint asks for an alias.
  - Verified with 112 server unit tests and 76 integration tests against MariaDB 10.11 and 12.3 and MySQL 8.4 and 9.7.
- 2026-11-14: M3 accepted by the operator. M4 started; plan approved with D13–D16.
  - Page documents arrive in M4 as far as access control needs them: rights, data sources, component restrictions, base filters, page filters and table source settings, with draft and publish through the API. M5 adds the page UI, version history, restore and compare, and chart settings.
  - Forms are part of the page model with their table and mode only; fields and writes follow in M6. The hotel criterion is covered for reads in M4 and for writes in M6.
  - The query builder's spec and compiler come in M4, its UI in M5. The permission overview and page issues arrive as API; their UI follows in M5.
- 2026-11-14: M4 implemented.
  - Roles with assignment by admins (D14), instance variables, and their pages in a new design area.
  - Access algebra in `packages/shared/src/access`, with property tests: restrictions never widen rights, the union over principals is monotone, and intersecting the static limits after the union equals intersecting per principal.
  - SQL validation, fail-closed:
    - The lexer checks the raw text, then writes a canonical text without comments and with one string form. That text is parsed and executed, so the parser and the database read the same statement.
    - The walker resolves every name per scope; an audit pass rejects whatever it did not resolve.
    - The read session drops SQL modes that change how quotes and strings are read.
    - A corpus of bypass attempts runs on both dialects.
  - Query library with immutable versions, parameter definitions, test runs with 100 rows, and the builder spec with its compiler (UI in M5).
  - Reads run as prepared statements in read-only transactions. `KILL QUERY` stops a statement 2 s after the server timeout, over a separate connection. This closes the item carried over from M3.
  - Table sources:
    - Lookup columns over up to three relations and display values.
    - Templates checked again at runtime (from the M3 review).
    - Base filters that fail closed.
    - NULL-aware keyset pages with HMAC-signed cursors.
    - Counts with the estimate of D7.
  - Cache with single flight, invalidation by table, views expanded and unknown view dependencies counted as all tables, and by variable. Also stale fallback, the 20 MB limit, live hints and paging snapshots.
  - Sections and pages: draft with revision, publishing with pinned query versions, and issues (§8.6). Compiled pages, render models without server-only configuration, branded handles, the permission overview (API), and schema impact for queries and components.
  - Verified:
    - `pnpm check` green, with 536 server, 25 shared and 4 web tests.
    - Coverage of the access algebra 100 % lines and 97.8 % branches; SQL validation, builder and `execution/sql` 99.7 % lines and 99.2 % branches.
    - 132 integration tests against MariaDB 10.11 and 12.3 and MySQL 8.4 and 9.7, among them: hotels kept apart with manipulated keys, keyset pages against the full sort, a payment visible at once through `v_zahlungsstatus`, the event switch to 2025, and both timeouts including `KILL QUERY`.
  - Decisions:
    - The page document arrives in M4 as far as access control needs it.
    - The MariaDB grammar of node-sql-parser rejects some column names such as `status`, so the MySQL grammar is the fallback.
    - Unqualified names that could mean an excluded column in any visible scope are rejected.
    - Words starting with a digit must be quoted.
  - Checked in the browser on the test stand (MariaDB 12.3):
    - Creating, editing and deleting roles and variables, including the confirmation step.
    - A value the variable's type rejects shows at the field.
    - Assigning a role in the user dialog, audited with old and new roles.
    - The settings switch for role creation by managers.
    - The user list now names the system role as such.
    - Test data was removed; the two test accounts are disabled, since accounts cannot be deleted.
  - Not checked in the browser: the role page as a manager without the right to manage roles; the route tests cover it.
- 2026-11-14: M4 reviewed in a fresh session. In the reviewed areas there were no blocking, 4 should-fix and 12 nice-to-have findings. The SQL validation was not fully reviewed in that session and still needs its own review. Fixed:
  - Stale results are served only while the target database cannot be reached. A read the database refuses (missing privileges, a denied account, an unknown schema) drops the expired entry, so revoked grants take effect at once. Denied accounts and unknown schemas now report `target_permission_denied`.
  - A request that arrives after an invalidation starts its own load instead of joining one that began before the write.
  - Tables on live queries page through their snapshot without running the query again; a reload or a manual refresh runs it again.
  - At most 128 prepared statements per target connection, so pooled connections cannot fill the server-wide `max_prepared_stmt_count`.
  - Verified with 541 server unit tests and 144 integration tests against MariaDB 10.11 and 12.3 and MySQL 8.4 and 9.7.
  - Open: the review of the SQL validation, and the nice-to-have findings.
- 2026-11-14: The database now enforces exposures and exclusions as well, so they no longer rest on the SQL validation alone.
  - Table access warns with `excluded_column_readable` when the read user may select a column excluded for everyone.
  - The connection page shows the read user's scope: objects it may read without table access, readable excluded columns, and the `REVOKE` and `GRANT` statements that limit it to the exposed objects and columns (column grants where columns are excluded).
  - The grant report records the account (`CURRENT_USER()`).
  - Exclusions of columns the read user no longer sees stay stored and can be saved again.
  - Verified with 547 server unit tests and 148 integration tests against MariaDB 10.11 and 12.3 and MySQL 8.4 and 9.7. On every engine, the suggested statements run as given, and the database then refuses the unexposed table and the excluded columns of a table and a view, while exposed data reads as before.
  - Checked in the browser on the test stand (MariaDB 12.3): after checking the grants again, the read scope lists the unexposed objects and the statements (`REVOKE` on the schema, `GRANT SELECT` on the one exposed table). The statements were not applied there. Not checked in the browser: the note on hidden exclusions in the access dialog.
  - Decision: the SQL validation stays an open point that is tested externally (penetration test); it does not block M5.
- 2026-11-15: The write user gets the same treatment as the read user.
  - Table access warns with `write_beyond_ceiling` when the write user may insert, update or delete beyond the ceiling; on views, any write counts.
  - The connection page shows the write user's scope next to the read user's: objects it may read without table access, readable excluded columns, writes beyond the ceiling, and the `REVOKE` and `GRANT` statements that limit it. It keeps `SELECT` on every exposed column, because writes check rows before and after, also through the joins of a base filter; `INSERT`, `UPDATE` and `DELETE` only where the ceiling allows.
  - Grants on objects the read user cannot see (so missing from the catalog) count too, because the grant report names them.
  - Verified with 552 server unit tests and 152 integration tests against MariaDB 10.11 and 12.3 and MySQL 8.4 and 9.7. On every engine, after the suggested statements the database refuses updates and deletes beyond the ceiling, writes to unexposed tables and views, and excluded columns, while allowed writes and the reads of a base filter's join still work.
  - Checked in the browser on the test stand (MariaDB 12.3): the write scope lists writes beyond the ceiling per object and suggests the statements (`REVOKE` on the schema and on unexposed tables, `GRANT` per ceiling). The statements were not applied there.
  - Carried forward to M6, at the operator's request: limit the write user's `INSERT` and `UPDATE` to the writable columns. Before implementing it, review whether it makes sense and what it affects (column sets that differ per component, generated and default values, `updated_at` set by the server, upserts, the simulation of D10), instead of applying it blindly.
- 2026-11-15: M4 accepted by the operator. M5 starts with medium effort; the query builder UI needs high.
- 2026-11-15: M5 plan approved with E1–E5. Work stops before the query builder UI (step 9), so the operator can raise the effort for it.
  - Plan: dependencies and chart palettes; result shapes, block settings and the document diff in `shared`; versions, restore, compare, reordering and a design catalog on the server; workspace shell, navigation and grid; blocks and charts; the editor with drafts, conflicts and publishing; version history and preview as role; the SQL editor; then the query builder UI.
  - E1: Markdown is rendered with `micromark` (MIT) without its HTML extension, so HTML in text blocks is escaped. An addition to the D8 list.
  - E2: On a draft conflict (`409`) the editor shows the structured diff between the own and the current draft. The manager either takes the current draft or saves the own one deliberately as a new revision.
  - E3: Builder queries store the spec and the SQL. Converting to SQL drops the spec from the next version on; the way back is an older version.
  - E4: The awards criterion is met in M5 with the table of medal candidates. The form "record award" can be placed as a block with table and mode; its fields follow in M6.
  - E5: Column role overrides (for example a number used as a dimension) live per block in its settings, not on the query.
- 2026-11-15: The operator delivered a provisional app icon (`stashley-icon.svg` and `.png`, outside the repo). It replaces the placeholder in `apps/web/src/brand/` and the favicon when it fits, at the latest in M9 or after the MVP. Check the SVG's size (143 KB) against the bundle budget before inlining it.
- 2026-11-15: M5 steps 1–5 implemented.
  - Libraries (ECharts, CodeMirror, dnd-kit, micromark) and chart palettes with a contrast test.
  - `shared`: shape analysis, block settings with mapping checks, chart data (limits, Other, NULL rules), page diff; 100 % lines.
  - Server: page versions, restore into the draft, navigation order, design connections and catalog; query versions learn their result columns once, so broken block mappings become page issues (`settings_missing` warning, `settings_invalid`, `mapping_broken`, `mapping_unsuitable` errors).
  - Web: navigation, start page, grid, page filters in the URL, metric, record, table, text and chart blocks; the page route is a lazy chunk, initial load 192 KB gzip.
  - Verified: 557 server, shared and 29 web unit tests, typecheck, lint, i18n. Not yet run: the integration suite (new test for describing result columns) and a browser check.
  - Decision to confirm: the metric comparison comes from a second column of the same query, not from a separate comparison query, so a block keeps one data source.
- 2026-11-15: M5 steps 6–8 implemented. Work stops before step 9, the query builder UI, as agreed.
  - Page list in the design area: sections and pages with drag-and-drop order (pointer and keyboard), moving between sections, creating and deleting.
  - Page editor in place (edit mode in the page header): rows and blocks by drag and drop or by choosing a row, layouts per block count, a block dialog for type, source, parameter bindings, chart, metric, record and table settings with role overrides and formats, rights of the page's viewers on the block's source and per-block hiding, and a suggested setup from the query's result columns. Page settings for title, description, viewers, page filters, URL parameters and MCP. Explicit save against the revision; a conflict shows the diff and lets the manager take the saved draft or save over it (E2). Publishing lists the pinned queries.
  - Version history with compare (any two versions or the draft, pinned query versions left out) and restore into the draft; preview as role with a bar to change roles or go back to editing.
  - Query library and SQL editor: CodeMirror (lazy) with highlighting and completion for exposed tables and columns, check, test run with typed test values for parameters and instance variables, the position of a validation problem, parameter definitions found in the SQL, builder queries read-only with one-way conversion, and the pages that use a query.
  - Table blocks on table sources choose their own columns; linked columns, base filters and editing are set up with table pages in M6.
  - Verified: 557 server, 63 shared and 43 web unit tests, typecheck, lint, i18n (738 keys), SPDX; 156 integration tests against MariaDB 10.11 and 12.3 and MySQL 8.4 and 9.7; initial load 193 KB gzip.
  - Checked in the browser on the test stand (MariaDB 12.3): writing, checking, test-running and saving a query in the SQL editor; creating a page, setting its viewers, adding a chart block from the suggestion and a text block, keyboard drag and drop, saving, publishing, the version list, the runtime view with its table view, and preview. Test page and query were removed again.
  - Found and fixed in the browser check: ECharts' HTML tooltips were blocked by the CSP and custom tooltip formatters put data values into HTML; tooltips now render on the canvas. The version compare no longer lists pinned query versions; the block dialog no longer requests a placeholder query.
  - Not checked in the browser: the draft conflict dialog, page filters, metric, record and table blocks with real data (the test stand's database has no demo data before M9), restore, a preview with roles (the stand has no roles), and the layout at 375 px.
  - Decision to confirm (from steps 1–5): the metric comparison comes from a second column of the same query.
- 2026-11-15: M5 step 9, the query builder UI, implemented (effort raised by the operator).
  - The query editor offers the builder next to the SQL editor. Base table; joins along shared relations in both directions (one each, several each) with "keep all rows" or "only matches"; columns with value, aggregates or time buckets that fit the column kind, reorderable by drag and drop, with output names that follow the column until renamed; filters with fixed values, parameters or instance variables and operators per column kind; sort order and limit. The grouping follows from the aggregated columns and is spelled out.
  - The server compiles the spec while the manager edits; the generated SQL, compiler notes (TIMESTAMP buckets in UTC without time zone tables) and field errors show at their rows. Parameter definitions follow the filters and take their type and list form from the column.
  - Converting to SQL asks first and is one way. Test runs name the visualizations the result fits.
  - Spec edits are pure functions with 13 unit tests that mirror the compiler's rules.
  - Verified: 56 web unit tests, typecheck, lint, i18n (843 keys), SPDX; initial load 193 KB gzip. On the test stand (MariaDB 12.3), a spec with a join, a weekly bucket, a count, a sum, a list filter, a parameter and a `LIKE` value with a quote compiled to the expected SQL, ran, and returned the expected column roles; unfitting functions came back as `not_numeric` and `not_a_time`.
  - Checked in the browser on the test stand: choosing the base table, adding the join to `person`, switching a column to `person.land` and another to a count, the derived grouping, removing columns, the live SQL, adding a sort entry, a test run with the suggested visualization, saving, reopening in builder mode, and converting to SQL after the confirmation. The test query was removed again.
  - Found and fixed in that check: sortable rows (builder columns, editor rows, page list) lost keyboard focus after a drop, and builder column rows were keyed by their name, so typing a new name rebuilt the field. Rows now keep their own IDs, and focus returns to the handle of the moved item.
- 2026-11-15: M5 implemented; in review.
  - Scenario pages on the test stand (MariaDB 12.3): the remaining demo tables and views were shared with the ceilings of the specification (views read-only; keys `anmeldung_id` for `v_zahlungsstatus` and `v_streckenlage`, `person_id` for `v_teilnahmen`, none for `v_medaille`); the instance variable `current_event_id` and the roles Orga, Kasse and Check-in were created.
  - Eight queries, three of them from the builder (registrations per week with a weekly bucket, participants by country with a join, stamps per station and quarter hour), five in SQL (overview metrics, the funnel, participants per last station, overdue participants with phone numbers, medal candidates).
  - Awards (`ehrung`) was built entirely through the UI: page, viewers, table block on the medal candidates with read for Orga, form block on `ehrung` in create mode with create for Orga, save, publish.
  - Overview and route status were assembled as drafts through the editor's API (`PUT …/draft`), then opened in the editor, checked without issues and published in the UI. They use metrics (one query for six values, currency format), a line chart on a weekly bucket, a funnel with role overrides (`stufe` ordered, `schritt` identifier), bars, a table with a duration format, and a heatmap.
  - Preview as role: Kasse sees every block of the overview and nothing on route status and awards; Orga sees all three pages.
  - The stand has no demo data, so blocks show zero values or "No data". Charts with data were checked earlier with a query of fixed values.
  - Found and fixed: funnel labels were cut off in narrow blocks; a preview whose roles see nothing now says so; admins and managers without a matching role saw a published page as an empty page without explanation and now get a hint that points to preview as role.
  - Acceptance criterion "a manager builds every demo page through the UI and checks it with preview as role": met for overview, route status and awards in the sense of M5 (awards fully by clicking, the other two through the editor's API and checked in the UI). Forms (M6) and table pages (M6) follow; the full criterion is tested end to end in M9.
  - Open points for the review: the metric comparison from a second column of the same query (decision to confirm); a preview for a role without the view right returns the page with no components instead of 404; views are offered as form sources (the issue `view_read_only` catches it).
- 2026-11-15: Noted for after the MVP: reduced profiles from one build, chosen when the instance starts.
  - Examples: without the public API or MCP, a single-user mode, a team mode where everyone has the same rights.
  - Disabled modules are neither registered nor loaded. The rights model stays as it is; a simple mode only simplifies the editor and writes grants to `authenticated` under the hood.
  - To keep a separate build cheap later: the core never imports from the `api` and `mcp` modules (enforce with `no-restricted-imports` from M7 on).
- 2026-11-15: M5 reviewed: 1 blocking finding, 7 should-fix, 10 nice-to-have. The operator approved B1 and S1–S7 for fixing, confirmed the open points and allowed clear, small nice-to-haves.
  - Open points decided: the metric comparison comes from a second column of the same query (confirmed). A preview for roles without the view right keeps showing the page, and the preview bar says it would be a 404 for them (N1). Forms no longer offer views as sources (N3).
  - B1: a deleted role locks a page's draft. `unknown_role` becomes a warning; the editor shows deleted roles in viewers and restrictions so they can be removed.
  - S1: rejected saves show translated issues with the block title instead of raw codes.
  - S2: in the builder, a parameter's list form follows the operator; the server rejects list parameters outside `in`/`not_in` for builder sources.
  - S3: the rights dialog offers only operations within the source's ceiling and the block type's capability (the design catalog carries the ceiling).
  - S4: a failed `describe` is retried after a while, publishing learns missing result columns, a matching design run stores them, and unknown columns show a warning.
  - S5: restoring a version asks first and shows the diff against the draft.
  - S6: the text filter follows its URL value, so back and forward work.
  - S7: the table search is debounced.
- 2026-11-15: M5 review findings fixed: B1, S1–S7 and the nice-to-haves N1, N3–N8. N9 (labels of chosen select filter values after a reload) and N10 (rich-text markup in chart labels, cosmetic) stay open.
  - N4: chart options are rebuilt when the locale changes. N5: without own edits the editor follows a newer draft saved by someone else, otherwise it says so. N6: concurrent publishes get 409 instead of 500. N7: the navigation order is checked inside its write transaction and only moved pages report a change. N8: comment fix.
  - The table source picker now opens on the connection of the current source; it used to start on the first connection.
  - Verified: typecheck, lint, SPDX, i18n (858 keys); 559 server, 63 shared and 61 web unit tests; 160 integration tests against MariaDB 10.11 and 12.3 and MySQL 8.4 and 9.7; initial load 193.4 KB gzip. Not checked in the browser.
- 2026-11-15: M5 fixes checked in the browser on the rebuilt test stand (with a temporary role and page, removed afterwards).
  - Confirmed: a deleted role shows as a warning, the page settings remove it and the draft saves (B1); a rejected save explains its problem in words (S1); rights stop at the ceiling, e.g. a form editing `ehrung` offers only read (S3); restoring asks first with the diff (S5); the text filter follows back and forward (S6); seven typed characters in a table search make one request (S7); a preview as Kasse of the awards page says it would be a 404, as Orga it shows the blocks (N1); forms offer no views (N3).
  - Found and fixed: discarding kept the rejected save's problems on screen; forms said "table or view".
  - Not reachable in the browser: N5, because queries do not refetch on window focus (`refetchOnWindowFocus: false`); the editor follows a newer draft only when the page detail is fetched again. S2 and S4 are covered by unit and integration tests only.
  - Seen on the stand, not changed: the draft of the awards page has three page filters with English labels ("Date", "Search", "Selection"), probably left from testing.
- 2026-11-15: The operator accepted M5 and asked for N9 and N10 before M6; both are fixed.
  - N9: the filter options route takes the chosen values and returns only their options, so a select filter restored from the URL shows its label.
  - N10: chart labels from the data get a zero-width space after each `{`, so zrender rich-text markup and ECharts template variables in values are shown as they are.
  - Verified: typecheck, lint, SPDX, i18n (860 keys); 559 server, 63 shared and 62 web unit tests; 160 integration tests against MariaDB 10.11 and 12.3 and MySQL 8.4 and 9.7; initial load 193.4 KB gzip. In the browser with a temporary query and page (removed afterwards): `?f.f1=AT` shows the label of AT; a donut with the categories `{fat|Rich}` and `Wert {d}` shows both unchanged.
  - Seen, not changed: donut labels show the share with ECharts' own number format ("62.5 %"), not the locale's ("62,5 %").
  - For M6, if it fits, otherwise after the MVP (operator, 2026-11-15): donut labels format the share through the locale. The label formatter in `apps/web/src/features/workspace/blocks/chart-options.ts` uses the template `'{b}: {d} %'`; a formatter function with `labels.percent` (as the other charts do) fixes it.
- 2026-11-15: M6 started. Review of the write user's column limits, tried on MariaDB 12.3 and MySQL 9.7 with column-level `INSERT` and `UPDATE` only:
  - An `INSERT` naming granted columns works; the others get their defaults. `ON UPDATE CURRENT_TIMESTAMP` sets `updated_at` without a privilege on it. `version = version + 1` and `SELECT … FOR UPDATE` work with column privileges.
  - Writing any other column (an excluded one, `updated_at` or `id` named explicitly) fails with error 1143 on both engines.
  - Result: column grants are not needed before forms write data. The write path writes only a component's writable fields, its row schema is strict, and excluded columns cannot be configured, so column grants are defense in depth. The other direction is needed: where a DBA sets column grants, writable fields must stay within them, or forms offer fields that fail with 1143.
  - Limiting per component makes no sense: one write user serves every page, the union of fields changes with each publish, and the statements would be stale at once.
  - Gaps found: an excluded `NOT NULL` column without default makes `create` impossible; the lock column must not be excluded.
- 2026-11-15: M6 plan approved with E6–E13. Steps: column grants; field model and row schema in `shared`; compiled write models and issues; the write path with locking, base filters, upserts, error translation and simulation; foreign key option lists; runtime routes; CSV export; form block; table pages with inline editing and detail view; editor; the donut share; tests and browser check. Model strength high for steps 1, 3–6 and the integration tests, medium otherwise.
  - E6: column grants are not a precondition for writes. Existing column grants limit writable fields (`grant_missing` per field). The write scope suggests column-level `INSERT` and `UPDATE` only on tables with exclusions (every other column that is not generated), table-level otherwise; nothing per component.
  - E7: the lock column is detected (an integer `version`, otherwise an `updated_at` DATETIME or TIMESTAMP); admins can override or turn it off on the table access. Never an excluded column.
  - E8: upserts use the primary key only when it is not auto-increment, otherwise a unique key without nullable columns. Auto-increment columns are never written.
  - E9: base filters apply to forms in every mode: required for the upsert lookup, and new rows must meet them.
  - E10: defaults from page filters and URL parameters come from the client, hidden or not. They prefill, they never restrict, and they pass the same checks. Only instance variables and the user context are set by the server.
  - E11: inline editing saves per cell (one `PATCH` with the version token; Escape discards). The manager chooses inline, dialog or both per table. No bulk editing or bulk deletion in the MVP.
  - E12: CSV export in UTF-8 with BOM; delimiter and decimal separator follow the user's format (`;` and `,` for German); dates ISO, date-times as wall times in `APP_TIMEZONE`; foreign keys as shown in the table. Text cells starting with `=`, `+`, `-`, `@`, tab or CR are defused; numeric columns stay numbers. At most 100,000 rows per export.
  - E13: rows are deleted one at a time with confirmation, also in the detail view; cascades follow the database's `ON DELETE` rules.
- 2026-11-16: M6 steps 1–5 implemented (effort high, as the operator asked).
  - Step 1 (E6): the write scope suggests `INSERT (…)` and `UPDATE (…)` on tables with exclusions; table access warns with `excluded_column_writable` and `excluded_column_required` and lists `writableColumns`.
  - Step 2: form fields (input or generated), defaults, foreign key options, the record of edit mode, upsert key, base filter and after-save action on forms; table editing and the CSV switch on table sources; detail tables on table pages. Documents saved before M6 get defaults. `checkRow`/`buildRowSchema` for client and server; date expressions evaluated with `Intl`, checked against Temporal in 2000 random cases per run. The lock column on table access (E7, migration `0006_table_lock`).
  - Step 3: write models compiled with the page, with issues (`required_field_missing`, `upsert_key_invalid`, `widget_unsuitable`, …); missing column grants withhold an operation (`grant_missing`). Render models carry fields and editing within the caller's rights, never hidden server defaults.
  - Steps 4–5: the write path with locked rows, base filter checks before and after, version tokens, unchanged writes, upserts, translated errors, audit, cache invalidation and simulation; foreign key option lists with exact matches and the `value_not_allowed` check.
  - Decisions made on the way:
    - Row locks take only the written table; the base filter is checked by a separate read in the same transaction. `FOR UPDATE` over joins would lock the joined tables and, on MySQL, need write privileges on them.
    - New rows get equality conditions of the base filter on their own columns as server values, so a form on the current event needs no event field.
    - Forms without `read` (create and upsert) answer with the key only, never with values of an existing row.
    - Option lists always search the display value; configured search columns are searched too and decide exact matches.
    - Generated dates and defaults apply when a record is created; on updates an editable generated date is an ordinary input.
    - Write sessions wait at most 10 s for a row lock (`row_locked`).
  - Verified: typecheck, lint, SPDX, i18n (892 keys); 568 server, 86 shared and 62 web unit tests; 196 integration tests against MariaDB 10.11 and 12.3 and MySQL 8.4 and 9.7, among them a payment that updates `v_zahlungsstatus` at once, hotels kept apart on writes with manipulated keys, a change moved out of the base filter refused, version conflicts, unchanged repeats, upserts, duplicate and missing references translated, simulation without DML, and writes after the write user was narrowed to column grants.
- 2026-11-16: M6 steps 6–12 implemented; M6 in review.
  - Server: route tests of the write endpoints; CSV export (E12) streamed per keyset page, at most 100,000 rows, audited as `table.exported`; related tables of a detail view read the rows of the shown record (`record`, reserved URL name `__record`); the design catalog lists auto-increment, required and writable columns and unique keys; render models name the column each inline field edits.
  - Web: form blocks (all widgets, numbers in the user's format, date-times as wall times of the instance, a searchable foreign key selection with exact hits and extras, defaults, conflict handling, the action after saving, `*` on required fields); tables edit cells inline, create and edit in a dialog, delete after confirmation and export CSV; table pages link rows to `/pages/:slug/:recordKey` with the record and its related tables; the block dialog configures form fields, defaults, generated dates, edit record, upsert key, base filters, linked columns, table editing and the CSV switch; table pages get related tables. The donut share follows the locale (from M5).
  - Found and fixed in the browser check: edit mode refused writes instead of simulating them against the ceiling (D10); the foreign key search said "no matches" while the input settled; a conflict in the row dialog left the table behind it stale.
  - Verified: typecheck, lint, SPDX, i18n (1024 keys); 572 server, 86 shared and 67 web unit tests; 204 integration tests against MariaDB 10.11 and 12.3 and MySQL 8.4 and 9.7; initial load 193.6 KB gzip.
  - Checked in the browser on the rebuilt test stand (MariaDB 12.3) with a temporary page, removed afterwards with its rows: an event form with a decimal comma and a client-side "at most 2 decimals"; upserting a person twice by email (created, then updated, "show record"); a registration with the person chosen by keyboard and the event from the hidden `current_event_id`; a payment where the typed start number was taken at once with the person's name as extra and today's date suggested; inline editing of a last name; a version conflict in the edit dialog; CSV export with `;`; a simulated write in preview at 375 px and in edit mode; the field editor of the block dialog.
  - Not checked in the browser: the detail view, delete with confirmation, the editor's base filter, linked column and related table controls (unit and integration tests cover the server side), and the station criterion end to end (no demo data on the stand; M9).
  - Open points for the review:
    - Stand's `anmeldung` display template falls back to `ticket_typ` (first text-like column); a template such as `{startnummer} – {person.nachname}` would make the payment selection readable. Configuration, not code.
    - The `Datenstand in 3 Sekunden` line shows a future time when the server clock runs ahead of the browser (from M5).
    - Required fields are marked with a plain `*` in the label text.
- 2026-11-16: M6 reviewed: 1 blocking finding, 4 should-fix, 9 nice-to-have. The write path held the base filter; reads were open in two places. The operator approved all fixes, the option list base filter (S1 variant a) and refusing access over withholding data (B1), and asked to take every nice-to-have along. General priority from now on: security and bugs, then quality and usability, then new features.
  - B1: upsert forms have no `read`, yet `GET …/rows/:key/edit` and the `version_conflict` answer of `PATCH` returned whole records. Updates by key and the record behind them now exist only for forms in edit mode and tables (others 404); conflicts carry the record only for readers; deletes only on tables.
  - S1: foreign key selections from a table listed and saved every record of the target, e.g. the kontingents of every hotel. A field now takes a base filter on its target (`reference.baseFilter`), applied to the list (cached per resolved value) and to `value_not_allowed`; the field editor offers it. Query lists reject it.
  - S2: equality conditions of the base filter now fill `NOT NULL` columns: they count as covered, make a field for the column optional on create and take part in the grant check.
  - S3: the export audit entry is written in `finally`, with the rows sent and `complete`, so cancelled or failed downloads are audited.
  - S4: write and export rate limits count per user, not per address.
  - N1: simulated writes read the row as the change or the new row would leave it (a derived table through the model and its base filter) and report `base_filter_violation`; simulated deletes report `still_referenced` for `RESTRICT`/`NO ACTION` keys; simulated updates answer with the new values.
  - N2: an upsert key found outside the base filter answers `unique_violation`, like a duplicate on create.
  - N3/N4: saving checks query option lists against a fresh result and validates page filter and URL values like reads. A value beyond the 10,000-row limit is refused.
  - N5: the keyset export stops at 100,000 rows even when rows arrive after the count.
  - N6: the catalog reads `ON DELETE`/`ON UPDATE` actions (snapshots without them compare as before); writes evict the cache of tables that cascades or `SET NULL` change too. Triggers stay invisible.
  - N7: the field editor says that visible server defaults only prefill.
  - N8: delete conflicts carry the new version token (readers only).
  - N9: a key the server cannot produce must be a field (`key_missing`).
  - Verified: typecheck, lint, SPDX, i18n (1028 keys); 580 server, 86 shared and 67 web unit tests; 216 integration tests against MariaDB 10.11 and 12.3 and MySQL 8.4 and 9.7, among them an upsert form refused `/edit` and `PATCH`, a hotel's kontingent selection without other hotels, a registration without event field, and simulated base filter violations and blocked deletes in edit mode.
  - Not covered by tests: a cancelled export (Fastify `inject` cannot abort a stream) and the per-user rate limit key.
  - Checked in the browser on the rebuilt test stand (MariaDB 12.3) with a temporary page and temporary rows, removed afterwards: a booking form whose kontingent selection is narrowed to one hotel lists only that hotel's kontingents (search "Einzel" finds one of two), and the field editor shows the condition under "Auswahl eingrenzen".
- 2026-11-16: M6 accepted by the operator. The priority order (security and bugs, then quality and usability, then new features) is for internal prioritization only; reports keep their usual structure. Work continues along the milestone plan.
- 2026-11-16: M7 plan approved with E14–E29. Steps: migration and module boundaries; API and import model in `shared`; endpoints and aliases; tokens; a resource model with its own authorized handle and a write path shared by components and the API; API reads and writes; OpenAPI; upload and parsing; imports into existing tables; new tables (extra high effort); web pages for the API and the import; tests and browser check.
  - E14: endpoints can be enabled only once the alias differs from the object name (case-insensitive); format `^[a-z][a-z0-9_-]{0,62}$`; errors and the OpenAPI document never name the table. Closes the item carried over from M3.
  - E15: effective token rights are grant ∩ enabled endpoint ∩ ceiling ∩ database grants, evaluated per request. Disabling an endpoint or lowering a ceiling deletes the affected endpoints and token grants, so raising it later reopens nothing; a save that would do so first answers with the consequences, and the dialog asks to confirm. Upsert is its own grant and needs `create` and `update` in the ceiling.
  - E16: the API reads every column not excluded for everyone, as raw values (§9.5), without display values or linked columns. Writable: not generated, not auto-increment, not the lock column, within column grants. Unknown and excluded columns in the body, `fields`, `filter` or `sort` reject the whole request with the same `400 unknown_field`; known read-only columns answer `422 field_not_writable`.
  - E17: a strong `ETag` from the version token over all writable columns and the lock value, in its own key space. `If-Match` on `PATCH`, `PUT /:id` and `DELETE` (`*` means "exists"); refused with `400` on `POST` and `PUT /?on=`. `PUT /:id` sets missing writable columns to `DEFAULT`.
  - E18: `?on=` takes the primary key when it is not auto-increment, or a single-column unique key; a nullable one requires its value in the body. `201` for a new row, `200` otherwise.
  - E19: table and view endpoints read live through the read user, without the query cache; API writes invalidate the cache of the UI. One sort column plus the key; `like` with client `%`/`_` and `\` as escape; `in` up to 100 values.
  - E20: tokens belong to the instance, not to the admin who created them. Name, expiry, IP allowlist and rate limit can change later (audited), the secret never. Invalid, expired or revoked tokens answer `401`, limited per IP; an address outside the allowlist `403`. Usage counters are written every 30 s.
  - E21: `/api/docs` without a token answers `401` with `WWW-Authenticate: Bearer`, like the API itself (the code is public, hiding the path would gain nothing). `STASHLEY_PUBLIC_API=off` leaves the API routes unregistered.
  - E22: managers and admins import within the ceiling (insert: `create`; upsert: `create` and `update`) through the write user, without base filters and independent of page rights. Auto-increment columns cannot be mapped. Upsert keys: the primary key or a unique key without nullable columns.
  - E23: every import needs a passed dry run with the same settings (fingerprint of file hash, options and mapping). The dry run only reads, like D10; `CHECK` constraints and triggers stay unseen.
  - E24: one audit event `import.completed` per import (file hash, mode, counts, table, options, user), not one per row.
  - E25: date-times without an offset are wall times in `APP_TIMEZONE`. Decimal separator and an optional thousands separator; true, false and empty values are configurable. Defaults come from the data where it is unambiguous, otherwise from the user's format. Non-text cells are trimmed.
  - E26: foreign keys resolve through a unique column of the target or its display value; an ambiguous display value is a cell error `ambiguous_reference`.
  - E27: dry runs and imports run in the background with progress; `STASHLEY_IMPORT_CONCURRENCY` (2), `STASHLEY_IMPORT_PER_USER` (1), `STASHLEY_IMPORT_MAX_MB` (50) and `STASHLEY_IMPORT_BATCH_SIZE` (500). Cancelling rolls back; a restart marks running jobs as failed.
  - E28: types and names are suggested from the whole file and can all be changed; the data is written by the schema user, and a failed data step leaves the empty table for a retry. A table designer without CSV uses the same form and DDL generator (create only, with column defaults).
  - E29: development dependency `@seriousme/openapi-schema-validator` (MIT) to check the generated OpenAPI document in tests; an addition to the D8 list.
- 2026-11-16: Noted for after the MVP: query endpoints on the public API, served from the query cache. Open questions: the endpoint pins a query version, and a new version needs the admin's approval again; how the objects and columns a query joins are disclosed (listed and confirmed by the admin, or each one must be an API resource itself); instance variables such as `current_event_id` change the results; paging through result snapshots within the 10,000-row limit; a separate grant in the token matrix. Until then, views cover joined data.
- 2026-11-16: M7 implemented; in review.
  - Public REST API (`modules/public-api`): `/api/v1/:resource` with list, get, count, schema, create, update, replace, upsert (`PUT /?on=`) and delete. Admins enable operations per table access within its ceiling once the alias differs from the table name (E14). Tokens `stl_api_…` with a CRC32 checksum, stored as a hash and shown once, with expiry, IP allowlist, a per-token rate limit and grants on enabled endpoints only (E20). Reads go live through the read user (E19); writes go through the M6 write path with the token as the actor and without a base filter. ETag and `If-Match` (412), idempotent upserts, `401` with a challenge, `404` for unknown aliases and disabled endpoints, `403` without a grant (D5). OpenAPI 3.1 per token at `/api/docs` (`401` without one, E21) and in full for admins, validated against the official schema in tests (E29). `STASHLEY_PUBLIC_API=off` leaves the routes out.
  - Lowering a ceiling, closing an endpoint, renaming or removing a table access that takes endpoints or token grants away asks first and lists the consequences (E15). Endpoints join the schema impact list.
  - The access module builds a resource model per table access (every column not excluded, writable columns within column grants, upsert keys) and hands out a new handle, `AuthorizedResource`. The row writer takes a write subject instead of a component, so forms and the API share one write path. The core may not import from the optional modules (lint rule).
  - CSV import (`modules/imports`): streamed upload with SHA-256, detected encoding, delimiter and header, formats suggested from data and the user's format (E25), preview, mapping by name, foreign keys by a unique column or the display value (E26), a dry run that only reads (E23), the import in one transaction in batches with all or nothing or skipping failed rows, one audit event (E24), background jobs within `STASHLEY_IMPORT_*` limits (E27), cleanup after 24 h.
  - New tables (E28): definitions suggested from every value of the file, editable; checks shared by client and server; `CREATE TABLE` from fixed pieces through the schema user, audited with the statement; data through the schema user; table access with ceiling read, `pending_grants` with the `GRANT` statement until the read user sees the table, and a check-again route. The table designer creates empty tables from the same definition.
  - Web: an API page (endpoints, tokens with a grant matrix, the secret shown once, OpenAPI download) and an import wizard in the design area with a table definition editor; the designer opens from the connection page.
  - Decisions made on the way:
    - Tables whose ceiling is create only serve API `create` and imports; their read operations stay closed.
    - API writes answer with the row only when the token may also `get` or `list`; otherwise with the key, like forms without read.
    - JSON columns are read-only through the API and the import.
    - An empty cell in a `NOT NULL` column with a default takes the default on insert.
    - True and false words are always German and English; the suggested date format is the one most values fit.
    - For new tables only the read user's `GRANT SELECT` is suggested; write grants come from the write scope once the ceiling is raised, and no schema-wide grants are suggested.
  - Verified: `pnpm check` green (typecheck, lint, SPDX, i18n with 1241 keys; 624 server, 116 shared and 67 web unit tests; coverage thresholds); 272 integration tests against MariaDB 10.11 and 12.3 and MySQL 8.4 and 9.7 (68 per engine), among them a create-only token, `If-Match`, replace with defaults, idempotent upserts, translated errors, Windows-1252 imports, foreign keys by unique column and display value, a rollback when the database refuses a row, new tables with `CREATE TABLE` on every engine, and a table that waits for the read user's grants until the statement ran; initial load 193.6 KB gzip.
  - Checked in the browser on the rebuilt test stand (MariaDB 12.3) with temporary rows, removed afterwards: payments as `payments` with list, get and create; a create-only token (secret shown once) creates a payment (`201`, key only), `list` answers `403`, the table name `404`, `/api/docs` `401` without and only `POST /payments` with the token; the audit log shows `row.created` with the token as the actor. A Windows-1252 file with semicolons and German dates became `m7_mitglieder` with an added `id`, `email` required and unique; after raising the ceiling, a second file upserted by `email`, and its dry run reported the faulty row beforehand.
  - Found and fixed in the browser check: endpoint states as full sentences in badges; visible labels on matrix and editor check boxes; the empty-values field had the label of the empty import list; the designer flagged the empty name at once.
  - Not checked in the browser: the `pending_grants` path with its statement and check again (the stand's read user may read the whole schema; covered by the integration test), the designer creating a table, cancelling a running import.
  - Left on the stand: the revoked test token (tokens cannot be deleted) and the audit entries.
- 2026-11-22: M7 reviewed (2026-11-17): 1 blocking finding, 8 should-fix, 12 nice-to-have. A token never read or wrote beyond grant, enabled endpoint, ceiling and database grants; the read limit was open in the import. The operator approved every fix with the recommended variants (B1 a, S3 b, S4 SELECT for create, S6 c).
  - B1: an upsert dry run counted unchanged and updated rows, so a manager could guess stored values of a table without read. Upsert imports now need read in the ceiling; without it only insert is offered.
  - S1: the import compared stored keys and foreign keys by exact text while the database compares with the column's collation, so `ANNA@example.com` was reported as new and the import failed on the unique index. Lookups return which batch value each row matched (`IF(column = ?, i, NULL)`); duplicates within the file compare by weight strings of the column's collation, which the catalog now records (`collation`).
  - S2: the owner and an admin starting one job at the same time imported the file twice. The slot is reserved before the first await and the job is claimed in the store from the statuses it may start from.
  - S3: `PUT /:id` always wrote left-out columns with a default, so each repeat bumped the version, broke open forms and wrote an empty audit entry; `created_at` went back to now. Literal defaults are written as their values, expression defaults keep the stored value (`defaultExpression` in the catalog), and a write without changes records no audit entry.
  - S4: create counted as granted with `INSERT` alone, yet the write path reads its row back, so create-only setups failed with 503. Create needs `SELECT` like update and delete.
  - S5: asymmetric column grants (INSERT ≠ UPDATE) withheld update or create on the API and in imports entirely. Each operation checks only the columns it writes, payloads keep to them, and the endpoint list shows what the resource model withholds.
  - S6: new tables got the server's default collation for utf8mb4 instead of the schema's, and joins with existing columns failed with 1267. The schema's collation is read fresh and written out; a checkbox per text column makes it case-sensitive (`utf8mb4_bin`).
  - S7: reading the first rows of a CSV left the file open, so deleted uploads kept their space. The stream chain uses `pipeline`.
  - S8: the per-address limit for invalid tokens was checked before the token, so bad requests from a shared address locked valid integrations out for hours. It applies to failed attempts only; unknown tokens are not cached; the log warns once when forwarded headers arrive without `TRUST_PROXY`.
  - N1: a table replaced by a view loses the endpoints and grants the view cannot serve, in the catalog's transaction. N2: a confirmation carries a fingerprint and covers exactly the listed consequences. N3: token grants are checked inside the saving transaction. N4: the GRANT statement escapes backticks. N5: a shutdown cancels running imports and waits up to 10 s. N6: `DELETE` with `If-Match` on a resource without a write model answers 412. N7: import failures in words, with the failed phase and a note when the table exists already. N8: token expiry as a local date, kept while unchanged; an expired token can be renamed. N9: a failed OpenAPI download shows an error. N10: text defaults refuse C1 control characters. N11: no change, the definition schema allows at most 200 columns. N12: the consequences notice scrolls into view.
  - Verified: typecheck, lint, SPDX, i18n (1249 keys); 629 server, 116 shared and 67 web unit tests; 288 integration tests against MariaDB 10.11 and 12.3 and MySQL 8.4 and 9.7 (72 per engine), among them two users starting one import, upserts and foreign keys in another letter case, repeated `PUT /:id` with literal and expression defaults, a table replaced by a view with a write endpoint and grant, and a new table in a `utf8mb4_unicode_ci` schema with a case-sensitive column.
  - Checked in the browser on the rebuilt test stand (MariaDB 12.3) with a temporary table, removed afterwards: the designer shows "Groß/klein" per text column with its hint and created `m7r_codes` with `code` in `utf8mb4_bin` and the table in the schema's `utf8mb4_uca1400_ai_ci`; lowering its ceiling with open endpoints showed the consequences notice in view; changing the API name while the notice was open made the server ask again with the longer list instead of saving; the confirmed list was saved exactly; removing the table access asked first, too.
  - Found and fixed in the browser check: removing a table access asked "Speichern nimmt Folgendes weg" and "Trotzdem speichern"; it now names the removal. Not checked in the browser after that fix (the stand runs the build before it).
  - Left on the stand: the audit entries of the check.
- 2026-11-22: Noted for after the MVP: case-insensitive search and sorting on case-sensitive text columns (`utf8mb4_bin`) at the query level, e.g. with an explicit collation for `contains` and the sort.
- 2026-11-22: M7 accepted by the operator. Asked whether M8 (MCP) is a large milestone; if it is large, complicated and brings new security implications, the operator prefers to move it after the MVP.
- 2026-11-22: M8 moved after the MVP (D17), as the operator decided: it is as large as M7, and its authorization server, client metadata fetched from foreign addresses and data leaving to AI providers bring new security questions. A slim variant with personal tokens only was offered and not chosen. Next is M9, which also hides the MCP controls until M8.
- 2026-11-22: M9 plan approved. Steps: MCP controls hidden (D17); demo data and `scripts/seed-demo.sh`; configuration export and import; the permission overview UI (§8.7, so far API only); app icon; Playwright end-to-end suite with axe; accessibility and performance; documentation site; release and docs workflows; verification.
  - Configuration export and import is for admins only. Conflicts (missing table access or columns on the target, a name that exists with a different ID) block the import and are listed; they are resolved by hand. Instance variables are exported with their values, home pages with their roles.
  - The end-to-end suite builds every demo page through the UI in one spec; its export becomes the fixture the other specs and the second instance import.
  - The test stand's database keeps the demo data for further testing.
  - Tools that run in containers (Playwright, mock OIDC provider, k6) are fine as long as they are removed completely afterwards. Load tests run on demand only.
  - The MVP is released as `0.1.0`; the operator tags and pushes.
  - The provisional icon (`stashley-icon.svg`) is used as delivered; smaller variants may follow from the operator.
- 2026-11-22: M9 implemented; in review.
  - MCP controls hidden behind `features.mcp` (D17): the table access MCP switch and MCP-only exclusion, the badge, the page setting and the description hint. Stored values are kept.
  - Demo data: new package `@stashley/demo` with the schema and users (moved from the server's fixtures) and a seeded generator. 13 events, 420 people from 23 countries, 260 registrations in 2026 (8 cancelled), 96 hotel bookings in 110 rooms, payments 214/15/23, 205 checked in, 61 at the finish, 3 overdue, 12 medal candidates, 3 earlier awards; the event day is set around now as 14:30. Times are stored as UTC, so the demo connection uses the time zone UTC. A verification query checks the figures through the views. `scripts/seed-demo.sh` starts or reuses a MariaDB container and prints the connection details.
  - Demo configuration (`node packages/demo/src/cli.ts config`): roles, `current_event_id`, the relation into `v_zahlungsstatus`, display templates, 16 queries and all eleven pages with stable IDs.
  - Configuration export and import (§24), admins only: preview of new, changed, unchanged and conflicting items; conflicts block and are resolved by hand; one transaction and one audit event; a fingerprint guards against changes since the preview.
  - Permission overview page for admins (§8.7).
  - Provisional app icon: optimized to 83 KB (30 KB gzip), static file outside the bundle, favicon, touch icons, manifest; an about dialog with version (signed-in users only), license and source code.
  - End-to-end suite (`e2e/`, `scripts/test-e2e.sh`): two instances, the demo database, mock-oauth2-server and Playwright 1.65.1 in Docker, one spec per acceptance criterion plus UI page building and first render on 4G; axe (WCAG 2.2 AA, serious and critical) on every visited page; CI job `e2e`. All containers, networks and volumes are removed afterwards.
  - Load test (`scripts/load-test.sh`, k6 in Docker): 50 users against an instance limited to 2 vCPU and 2 GB for 90 s, 26,116 requests, 0 % failed, P95 41 ms for cached and for live reads (thresholds 300 ms and 1 s).
  - Documentation site (VitePress, `docs/`): admin guide with the `email_verified` note, manager guide, REST API with a reference generated from the demo instance's OpenAPI document, demo, architecture, changelog; `docs.yml` publishes it to GitHub Pages.
  - `release.yml`: tag `vX.Y.Z` → multi-arch image on ghcr.io with SBOM and provenance attestations, keyless cosign signature, GitHub release from the changelog section; `latest` only for tags on main, no major tag for 0.x. actionlint is clean.
  - Found and fixed on the way:
    - MariaDB failed prepared statements on some views with error 1356 when they ran a second time (`v_medaille` after switching the event); such reads now drop the statement and run once more.
    - A foreign key selection with a default from a page filter opened its option list by itself in the focused field and hid the rest of the page from screen readers; typing the same exact start number again after the form cleared was not taken; form fields defaulted from a page filter did not follow a filter chosen after loading.
    - Contrast of warning text, keyboard access to sideways-scrolling tables, names of the editor's edit and delete buttons.
    - Static files went out uncompressed; the build now writes Brotli and gzip variants, and a page link loads session, messages, page chunk, navigation and page side by side. Dashboards and table pages now render in under 2 s on Fast 4G (2.45 s before).
    - pnpm 12 ignores `onlyBuiltDependencies`; the workspace uses `allowBuilds`.
    - Deleted pages kept their address, so neither a new page nor the import could use it again (found by the operator importing the demo configuration into the test stand); deleting now frees it, and migration 0008 frees the addresses of pages deleted before.
    - Test fixtures created views with mysql2's default collation, which clashes with Stashley's sessions (error 1267); they now use the server default like the seed script.
  - Verified: `pnpm check` green (632 server, 116 shared, 6 demo and 67 web unit tests); 328 integration tests against MariaDB 10.11 and 12.3 and MySQL 8.4 and 9.7, among them the demo data, the configuration transfer between two instances and the whole demo scenario; 34 end-to-end tests; the documentation site builds; initial load 194.5 KB gzip.
  - Checked in the browser on the rebuilt test stand: configuration page, permission overview, about dialog, the new icon, and the overview with the demo data. The stand's database now holds the demo data (`scripts/seed-demo.sh --name stashley-test-db`); the stand's configuration is unchanged: its connection keeps the time zone Europe/Berlin and `current_event_id` is 1 (2012 in the new data). For the 2026 scenario set the time zone to UTC and the variable to 13, or import the demo configuration after removing the M5 test pages, roles and queries that clash with it by name.
  - Not verified: the CI jobs `e2e`, `docs.yml` and `release.yml` (they need a push and a tag); the load test is not in CI and runs on demand.
  - Open for the final review: the manager criterion is met for four representative pages through the UI, the other seven come from the configuration import.
