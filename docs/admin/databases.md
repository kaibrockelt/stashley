# Databases and privileges

A connection has up to three database users. Stashley checks each one with `SHOW GRANTS` when it is saved and every time you press **Check privileges**, and warns about privileges beyond what it needs.

| User | Needs | Used for |
| --- | --- | --- |
| Read user | `SELECT` on the shared tables and views; `SHOW VIEW` on shared views | Every query |
| Write user (optional) | `SELECT`, `INSERT`, `UPDATE` and, where rows may be deleted, `DELETE` on the shared tables | Forms, table editing, the REST API, CSV imports into existing tables |
| Schema user (optional) | `CREATE` and `INSERT` on the schema | New tables from CSV files |

Without a write user, the connection is read only.

```sql
CREATE USER 'stashley_read'@'%' IDENTIFIED BY '…';
GRANT SELECT, SHOW VIEW ON shop.* TO 'stashley_read'@'%';

CREATE USER 'stashley_write'@'%' IDENTIFIED BY '…';
GRANT SELECT, INSERT, UPDATE ON shop.* TO 'stashley_write'@'%';
GRANT DELETE ON shop.order_items TO 'stashley_write'@'%';
```

Once tables are shared, the connection page shows each user's **scope**: objects it may read without being shared, excluded columns it can read, writes beyond the upper limits, and the `REVOKE` and `GRANT` statements that narrow it to exactly what is shared. Running them makes the database enforce the sharing as well, not only Stashley.

## Sharing tables

A table or view is invisible in Stashley until it is shared. For each one the admin sets:

- **Upper limit**: the operations pages may offer at most (read, create, update, delete). Views are read only.
- **Key column**: the primary key of a table (one column; tables without one cannot be shared), a unique column of a view, or none, which makes the view work like a stored query.
- **Display value**: how a row appears in selections and lookups, for example `{startnummer} – {person.nachname}`.
- **Hidden columns**, which appear in no query, form, export or API response.
- **Lock column** for concurrent edits: a `version` integer or `updated_at` column, found automatically.
- **Name in the API**, which must differ from the table name before REST endpoints open.

**Relations** come from foreign keys; add virtual relations where the schema lacks them, also one-to-one into views.

## Time zones

Each connection has a time zone: the one in which its `DATETIME` values are stored. Stashley shows times in `APP_TIMEZONE`. Sessions run with `time_zone = '+00:00'`, so views comparing with `NOW()` see UTC; store event times in UTC or set the connection's time zone to match how they are stored.

## Schema changes

Stashley reads the schema when a connection is saved, on **Read schema**, and once a day. Changes are listed with every query, page component, relation and API endpoint they affect.

If a view compares string literals and queries fail with error 1267 (illegal mix of collations), the view was created with a connection collation other than the server's default; create it again from a session with `SET NAMES utf8mb4`.
