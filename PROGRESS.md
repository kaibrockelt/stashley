# Progress

**Current milestone:** M6 – Forms and table pages (open)

**Next step:** Plan M6 – forms and table pages – in a fresh session; start with the review of the write user's column limits (see log 2026-11-15).

**Recommended model strength:** M6: medium (write path and base filters: high).

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
| M6 | Forms and table pages: forms, generated fields, default values, foreign key selects, inline editing, deletion, optimistic locking, error translation, CSV export; column limits for the write user's `INSERT` and `UPDATE` (review first, see log 2026-11-15) | Medium (write path and base filters: high) | Open |
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
- [ ] Direct API calls outside a user's rights are rejected: a foreign component ID, extra payload fields, manipulated parameters. One hotel's front desk cannot read or change the other hotel's bookings, even with a manipulated ID. (Met for reads in M4, through the API; changing follows with the write path in M6, the end-to-end test in M9.)
- [x] A manager cannot grant rights above a ceiling. Saving SQL with `UPDATE`, `DROP`, multiple statements or tables without table access is rejected. (Through the API; the editor UI follows in M5.)
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

D1–D12 approved on 2026-11-12, D13–D16 on 2026-11-14. Rationale for D1–D12 for each is in [`docs/architecture.md` §28](docs/architecture.md#28-decisions-requiring-approval).

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
