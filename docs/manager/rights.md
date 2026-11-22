# Rights

Rights come in three layers; what a user may do is their intersection:

1. **Upper limit** per shared table, set by admins: read, create, update, delete.
2. **Page rights**, set by managers: which roles see the page, and per data source of the page which operations each role has.
3. **Component restrictions**: a block can narrow the page rights for a role, or hide itself from it, but never widen them.

The database privileges of the read and write users apply on top.

The rights dialog of a block offers only what the upper limit and the block type allow. Rights belong to the data source, so blocks on the same table share them. Components a role may not read are not delivered at all — they are missing from the page's HTML and from every API response — and forms are delivered only to roles that may write.

**Preview as role** shows exactly this. **Administration → Permissions** lists, derived from the published pages, which role may do what on which table through which page and component.

Admins and managers see every page and can read all shared data in edit mode; they write through pages only within their own roles.
