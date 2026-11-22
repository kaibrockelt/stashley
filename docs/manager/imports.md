# CSV import

**Design → Import** imports CSV files of up to 50 MB into shared tables. Admins and managers may import into tables whose upper limit allows creating rows (and updating, for upserts); admins can also create a new table from a file.

1. **Upload**: encoding (UTF-8, UTF-8 with BOM, Windows-1252), delimiter and header row are detected and can be changed.
2. **Format**: decimal and thousands separator, date and date-time format (for example `DD.MM.YYYY`), words for yes, no and empty.
3. **Target**: a table and the mode — insert only, or insert or update by the primary key or a unique key. Optionally skip faulty rows instead of stopping.
4. **Columns**: mapped by name, changeable. Foreign keys can be found by a unique column of the target (an email instead of an ID) or by its display value.
5. **Preview** of the first rows with faulty cells marked.
6. **Dry run** over all rows without writing: new, updated, unchanged and faulty rows, with an error list to download.
7. **Import** in one transaction: all or nothing, unless faulty rows are skipped.

Every import is recorded in the audit log with the file's hash, mode, counts and user. Uploaded files are deleted after the import, at the latest after 24 hours.

## New tables

For a new table Stashley suggests a name, column names in `snake_case` and types from every value of the file (whole and decimal numbers, dates, date-times, yes/no, text with room to spare, long text). Everything can be changed; add a running number as primary key or choose a column whose values are unique and never empty, and mark unique and required columns. The table is created by the connection's schema user and shared read only; raise its upper limit to write to it. If the read user cannot read it yet, Stashley shows the `GRANT` statement for the database administrator and keeps the table locked until then.
