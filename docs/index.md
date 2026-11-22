# Stashley

Stashley builds dashboards, forms and table views on top of existing MariaDB and MySQL databases and delivers them to users by role. It runs as one Docker container with an embedded metadata store.

- **Admins** connect databases, share tables and views with an upper limit of operations, manage accounts, the REST API and the instance.
- **Managers** build pages from queries and shared tables, grant rights to roles within those limits, and preview pages as a role before publishing.
- **Users** work with the pages of their roles.

Security rests on the privileges of the database users; Stashley adds its own checks on top and runs only stored components, never ad-hoc SQL from the browser.

## Where to start

| You want to | Read |
| --- | --- |
| Install and operate an instance | [Admin guide](/admin/) |
| Build pages, queries and forms | [Manager guide](/manager/) |
| Connect an integration | [REST API](/api/) |
| Try everything with sample data | [Demo](/demo) |

Supported databases: MariaDB 10.11, 11.4, 11.8 and 12.3; MySQL 8.4 and 9.7.
