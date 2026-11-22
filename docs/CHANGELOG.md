# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [semantic versioning](https://semver.org/).

## [Unreleased]

### Added

- Monorepo with server, web client and shared package.
- Metadata store with migrations, online backup and restore.
- Health and readiness endpoints, structured JSON logs, graceful shutdown.
- Web client shell with design tokens, light and dark themes, English and German.
- Local accounts with Argon2id passwords, server-side sessions, CSRF protection and rate limits.
- Two-factor authentication (TOTP) with recovery codes, optionally enforced.
- OIDC sign-in; new accounts wait for admin approval unless their domain is approved.
- Invitations and password reset by email or link.
- User administration, identity providers, instance settings and an append-only audit log with CSV export.
- CLI commands `user create --admin`, `user reset-password`, `user reset-mfa` and `auth enable-local`.
- Database connections to MariaDB and MySQL with read, write and schema users, encrypted credentials, TLS and a guard against connecting to Stashley itself.
- Grant check for every database user, including its roles, with warnings about privileges beyond what it needs.
- Schema reading with keys, foreign keys and view dependencies, a daily comparison and a list of what a change affects.
- Sharing of tables and views with upper limits, key columns for views, hidden columns, display values and relations, including relations into views.
- CLI command `rotate-key`.
- Roles, instance variables, a query library with versions, SQL validation and a query builder, page and component rights within the upper limits, base filters, keyset paging and a query cache that writes refresh, also through views.
- Pages and dashboards: sections and navigation, drafts, versions with compare and restore, preview as role, rows of metrics, charts (bars, stacked bars, donut, line, area, columns, funnel, heatmap, scatter, bubbles), tables, records and text.
- Forms with automatic values, defaults and searchable foreign key selections; table pages with inline editing, a detail view, deletion, optimistic locking, translated database errors and CSV export.
- REST API with per-table endpoints, tokens with rights, expiry, address allowlist and rate limit, ETags and an OpenAPI document per token.
- CSV import into existing tables and new tables, with dry run, upserts and foreign keys found by a unique column or the display value.
- Configuration export and import between instances, with a preview of new, changed and conflicting items.
- Permission overview for admins.
- Demo database (`scripts/seed-demo.sh`) and demo configuration.
- About dialog with version, license and source code; provisional app icon.
- Documentation site with admin guide, manager guide and API reference.

