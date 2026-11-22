# REST API

The REST API under `/api/v1` gives integrations access to single shared tables. It is closed for every table until an admin opens operations on it, and every request needs a token.

## Endpoints

Open endpoints in **Administration → API**, per table and within its upper limit, once the table has a **name in the API** that differs from its real name. The real table name never appears in the API.

| Operation | Request |
| --- | --- |
| list | `GET /api/v1/{resource}` |
| get | `GET /api/v1/{resource}/{id}` |
| count | `GET /api/v1/{resource}/count` |
| schema | `GET /api/v1/{resource}/schema` |
| create | `POST /api/v1/{resource}` |
| update (partial) | `PATCH /api/v1/{resource}/{id}` |
| replace | `PUT /api/v1/{resource}/{id}` |
| upsert | `PUT /api/v1/{resource}?on={column}` |
| delete | `DELETE /api/v1/{resource}/{id}` |

## Tokens

Tokens start with `stl_api_`, are shown once and stored only as a hash. Each has its rights per resource and operation, an optional expiry date, an optional list of allowed addresses and a rate limit (60 requests per minute by default). Revoking takes effect at once.

```bash
curl -H "Authorization: Bearer stl_api_…" https://stashley.example.com/api/v1/payments?limit=100
```

## Conventions

- JSON in and out (`application/json; charset=utf-8`); errors as `application/problem+json` with a stable `code` and field errors.
- Times as ISO 8601 in UTC, dates as `YYYY-MM-DD`, `DECIMAL` and `BIGINT` as strings.
- `list` pages with a cursor: `{ "data": […], "next_cursor": "…" }`, `limit` up to 1000, `sort=-column`, `fields=a,b`, filters as `filter[column][op]=value` with `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `like`, `null`.
- Every row carries an `ETag`; send it as `If-Match` with `PATCH`, `PUT` and `DELETE` to refuse lost updates (`412`). Repeating an unchanged write changes nothing.
- `401` for a missing or invalid token, `403` for an operation the token may not use, `404` for unknown resources and rows.
- Writes appear in the audit log with the token as actor.

Each instance serves its OpenAPI 3.1 document at `/api/docs`; with a token it lists exactly what that token may use. The [reference](/api/reference) shows the document of the demo instance.
