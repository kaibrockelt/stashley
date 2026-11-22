# Moving a configuration

Pages, queries, roles with their home pages, instance variables with their values, virtual relations and display templates can be exported as one JSON file and imported into another instance, for example from a staging instance to production. Admins do both in **Administration → Configuration**.

The file never contains database passwords, accounts, role assignments, upper limits, hidden columns or REST API settings. Connections are referred to by name.

## Import

1. On the target instance, connect the databases and share the tables and views the configuration uses. The import does not change sharing.
2. Choose the file. Connections with the same name are mapped already; map the others.
3. **Check** compares every item with the instance: new, changed, unchanged, or in conflict.
4. **Import** writes everything in one transaction and records one audit entry. It is offered only while nothing conflicts and runs only if nothing changed since the check.

Items keep their IDs, so importing a newer file from the same source updates what an earlier import brought. Published pages become a new published version; drafts are replaced.

| Conflict | Resolve by |
| --- | --- |
| Connection not mapped | Mapping it, or adding the connection |
| No table access on this instance | Sharing the table or view |
| Name already used by another item | Renaming one of them |
| Version differs here | A query was changed on both instances; keep one by editing the other |
| SQL not valid here | Sharing what the query reads, or fixing it on the source |
| Type or value does not match | Aligning the instance variable |
| Deleted on this instance | The import does not bring deleted items back; recreate it on the source, which gives it a new ID |

Conflicts block the whole import; resolve them on either instance and check again.
