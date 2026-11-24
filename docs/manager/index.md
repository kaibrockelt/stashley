# Pages

Pages appear in the navigation, grouped in sections, in the order of **Design → Pages** (drag them, or use the handle with the keyboard). There are two kinds:

- **Dashboards** consist of rows with one to four blocks: metrics, charts, tables, records (one row as a list of values), forms and text. Below 768 px all blocks stack.
- **Table pages** show one shared table, view or query full width, with search, sorting, paging, CSV export and, for tables, editing and a detail view of a record with the records that refer to it.

## Editing

Open a page and choose **Edit page**. Changes stay in a **draft**: save it with **Save draft** — every save is recorded — and nobody but designers sees it until **Publish**. Publishing pins the current version of every query the page uses; later changes to a query reach the page only when it is published again. The last 20 published versions can be compared and restored into the draft.

If two people save the same draft, the second sees the differences and decides which version to keep; nothing is overwritten silently.

**Preview as role** shows the saved draft with the rights of one or more roles. Writes are only checked there, never saved.

## Page settings

- **Who sees the page**: roles, or everyone signed in. Seeing a page does not yet allow reading its data; that is a right per data source (see [Rights](/manager/rights)).
- **Page filters**: a date or date range, a selection from a query, or a text search. They act on the blocks bound to them — as named parameters of queries, on a column of a table source, or as a form's default or record. Users see only the filters that feed a block they can see.
- **URL parameters**, for example the record a row link opens.

## Charts

The structure of a query's result decides which charts fit; the block dialog suggests one (**Use the suggested setup**). Column roles — measure, time, category, ordered dimension, identifier — come from the column types and can be overridden per block, for example to use a station number as an ordered dimension. Every chart has a table view and tooltips with exact values; colors come from the theme and are never the only carrier of meaning.
