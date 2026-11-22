# Queries

Queries live in the library (**Design → Queries**) and can be used by many blocks. Each saved change creates a new version; pages use the version that was current when they were published.

## Builder and SQL

The **query builder** starts from a shared table and adds joins along relations, columns with aggregates or time buckets (quarter hour to year), filters, sorting and a limit. Its SQL is shown as you build. Converting a builder query to SQL is possible once and cannot be undone.

The **SQL editor** checks as you go and on save. Allowed is exactly one `SELECT` (with `WITH`, `JOIN`, `UNION` and subqueries) on shared tables and views and their visible columns, with functions from an allow list. Rejected are writes and DDL, several statements, locking clauses, `INTO`, variables with `@`, executable comments and system schemas such as `mysql` or `information_schema`.

## Parameters

Named parameters such as `:station` are bound, never pasted into the SQL. Their values come from page filters, URL parameters, the signed-in user (`:current_user_id`, `:current_user_email`) or **instance variables** such as `:current_event_id`, which admins and managers maintain in **Design → Instance variables**. Changing a variable refreshes every cached result that uses it.

Page filters and URL parameters only select; users can change them. Restrict data with rights and base filters instead.

## Cache

Each query has a cache duration, from live to 24 hours. Writes through Stashley — forms, table editing, the REST API and CSV imports — refresh the cached results of every query that reads the written table, also through views. Changes made outside Stashley show after the cache expires. Every block shows how old its data is and can be refreshed by hand.
