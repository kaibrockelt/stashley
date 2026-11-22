# Sign-in and accounts

## System roles and roles

Every account has one system role:

| System role | May |
| --- | --- |
| Admin | Everything a manager may, plus databases and sharing, users and their roles, the REST API, settings and the audit log |
| Manager | Build pages, queries and forms, import CSV files into existing tables, maintain roles (unless turned off) and instance variables, preview pages as a role |
| User | Use the pages of their roles |

**Roles** (Orga, Kasse, …) carry the rights on pages. Managers create them and grant them rights; only admins assign them to accounts. A role can have a home page.

## Local accounts

Admins invite people in **Administration → Users**. With SMTP configured, the invitation is emailed; otherwise copy the link from the dialog. Passwords need at least 12 characters and are checked against a list of common passwords. Admins can enforce two-factor authentication (TOTP with recovery codes) for all local accounts.

## Identity providers (OIDC)

Add providers in **Administration → Identity providers** with issuer URL, client ID and secret. The callback URL to register at the provider is shown there. A person signing in through a provider for the first time gets a **pending** account and sees only a waiting page until an admin approves it and assigns roles; email domains listed as auto-approved skip that step.

::: warning Only connect providers that verify email addresses
A sign-in through a provider is linked to an **existing** account with the same email address only when the provider reports the address as verified (`email_verified`). Stashley relies on the provider for that claim. Connect only providers that actually verify the addresses of their users — the usual company directories (Microsoft Entra ID, Google Workspace, Keycloak or Authentik with verification turned on) do. A provider where anyone can register any address unverified, or that sends `email_verified: true` without checking, would let its users take over accounts with the same address.
:::

Password sign-in can be turned off once a provider and an admin with a linked provider account exist. If the provider is ever unavailable, turn it back on from the server:

```bash
docker compose exec stashley stashley auth enable-local
```

## Emergency commands

| Command | Purpose |
| --- | --- |
| `stashley user create --admin --email <email> --password-file -` | Create an admin, reading the password from stdin |
| `stashley user reset-password --email <email>` | Print a reset link; with `--password-file` set the password directly |
| `stashley user reset-mfa --email <email>` | Turn off two-factor authentication of an account and end its sessions |
| `stashley auth enable-local` | Turn password sign-in back on |

Run them with `docker compose exec stashley …`.

## Audit log

Sign-ins and failed attempts, changes to accounts, roles, databases, sharing and pages, configuration imports and every write to a target database (with old and new values) are recorded in **Administration → Audit log**. Entries cannot be changed; they are removed only after the retention period (365 days by default, in **Settings**). The log can be exported as CSV.
