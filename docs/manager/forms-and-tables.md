# Forms and table pages

## Forms

A form writes one shared table in one of three modes: **create**, **edit** (the record comes from a page filter or URL parameter) or **create or update** (found by a unique key).

Each column is an input field, an automatic value, or left out. Input types follow the column type; foreign keys become a searchable selection that shows the target's display value. A selection can be narrowed (only the rooms of one hotel) or come from a query (only paid registrations not yet checked in). Typing a value that matches exactly one option, such as a start number, takes it at once — Enter saves.

**Automatic values**: auto-increment keys, and dates such as `now`, `today` or `now + 1d`, fixed or as an editable suggestion.

**Defaults** come from a fixed value, an instance variable, the signed-in user, a page filter or a URL parameter. Hidden defaults from a variable or the user are set by the server and cannot be changed by the browser; defaults from page filters and URL parameters only prefill.

Required fields follow from the database (`NOT NULL` without default) and can be added. Values are checked in the browser and on the server with the same rules; database errors such as duplicates or missing references are translated into messages at the field.

## Table pages and table blocks

Choose the columns, also from related tables over up to three relations (shown read only), their labels and formats, sorting, search columns and page size. A **base filter** limits the rows for good: fixed values, instance variables or the signed-in user, also over relations — for example `hotel_kontingent.hotel_id = 2` for one hotel's guest list. It applies to reading and writing, and new rows must meet it.

**Editing** offers create, update and delete as the rights allow: cells inline, a dialog, or both. Concurrent edits are detected through the lock column; a conflict shows the current record and saves nothing. Deleting asks first.

The **detail view** of a table page lists the records of other tables that refer to the opened record, each as its own component with its own rights.

**CSV export** follows the user's format (`;` and decimal comma for German), defuses cells starting with `=`, `+`, `-` or `@`, exports at most 100,000 rows and is recorded in the audit log. It can be turned off per table.
