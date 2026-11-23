# Moving a configuration

Pages, queries, roles with their home pages, instance variables with their values, virtual relations and display templates can be exported as one JSON file and imported into another instance, for example from a staging instance to production. Admins do both in **Administration → Configuration**.

The file never contains database passwords, accounts, role assignments, upper limits, hidden columns or REST API settings. Connections are referred to by name.

## Import

1. On the target instance, connect the databases and share the tables and views the configuration uses. The import does not change sharing.
2. Choose the file. Connections with the same name are mapped already; map the others.
3. **Check** compares every item with the instance: new, changed, unchanged, or in conflict. Pages are checked as the editor would check them after the import, with the file's relations, display values, queries and roles in place.
4. **Import** writes everything in one transaction and records one audit entry with the old and new values of instance variables and the page and query versions. It is offered only while nothing conflicts and runs only if nothing changed on this instance since the check; otherwise check again.

Items keep their IDs, so importing a newer file from the same source updates what an earlier import brought. Published pages become a new published version; drafts are replaced. A page deleted on this instance comes back, marked as restored.

Some problems do not block the import and are listed as notes, for example a right above a lower upper limit on this instance (the right then does not apply), or a query builder that produces other SQL here. The page editor shows them afterwards.

| Conflict | Resolve by |
| --- | --- |
| Connection not mapped | Mapping it, or adding the connection |
| No table access on this instance | Sharing the table or view |
| Column or relation missing or hidden here | Showing the column, adding the relation, or changing the page on the source |
| Name already used by another item | Renaming one of them |
| Version differs here | A query was changed on both instances; keep one by editing the other |
| SQL not valid here | Sharing what the query reads, or fixing it on the source |
| Type or value does not match | Aligning the instance variable |
| Twice in the file | The file was edited by hand; remove one of the two entries |

Conflicts block the whole import; resolve them on either instance and check again.
