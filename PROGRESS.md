# Progress

**Current milestone:** M0 – Architecture plan (in review)

**Next step:** The operator reviews [`docs/architecture.md`](docs/architecture.md), especially §28 (decisions requiring approval) and §29 (open questions). M1 starts after approval.

**Recommended model strength for M1:** medium. Before M1 starts, review M0 in a fresh session with high model strength.

## Milestones

| Milestone | Scope | Model strength | Status |
| --- | --- | --- | --- |
| M0 | Architecture plan | Strongest, maximum effort | In review |
| M1 | Scaffold and operations: monorepo, CI, Dockerfile, build script, metadata store, health, logs, backup and restore, i18n and design token foundations | Medium | Open |
| M2 | Sign-in and accounts: local accounts, sessions, CSRF, 2FA, OIDC with approval, system roles, profile, recovery CLI, audit log | High | Open |
| M3 | Connections and table access: database users, grant inspection, encryption, key rotation, schema introspection and diff, ceilings, column exclusions, virtual relations, display templates | High | Open |
| M4 | Queries, access control and cache: query library, SQL validation and execution, parameters, instance variables, roles, page and component rights, base filters, pagination, cache invalidation | Strongest, maximum effort | Open |
| M5 | Pages and dashboards: workspace shell, navigation, drafts and versions, grid, blocks, charts, query builder, SQL editor, preview as role | Medium (query builder: high) | Open |
| M6 | Forms and table pages: forms, generated fields, default values, foreign key selects, inline editing, deletion, optimistic locking, error translation, CSV export | Medium (write path and base filters: high) | Open |
| M7 | Public REST API and CSV import: endpoints, tokens, OpenAPI, imports including new tables | High | Open |
| M8 | MCP server: authorization server, metadata, tools, MCP exposure, privacy notice, call log | High | Open |
| M9 | Demo scenario and acceptance: seed script, configuration export and import, end-to-end suite, accessibility, performance, documentation, release pipeline | Medium (final review: high) | Open |

Status values: open, in progress, in review, done.

## Acceptance criteria

- [ ] `docker compose up` with values from `.env.example` installs the instance, and the first admin can sign in.
- [ ] The admin connects the demo database, gets a warning for the deliberately over-privileged user, and grants table access with the demo ceilings.
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
- [ ] `scripts/build.sh --platform linux/amd64,linux/arm64` builds both architectures.
- [ ] The Playwright end-to-end suite covers all criteria above and runs in CI against the demo database.
- [ ] The UI is complete in English and German, with UI copy written specifically for the product.

## Deviations from the specification

None approved yet. Proposals D1–D12 await approval in [`docs/architecture.md` §28](docs/architecture.md#28-decisions-requiring-approval).

## Log

- 2026-11-12: M0 started. The architecture plan is drafted and ready for review.
