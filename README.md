# CutOver Agent

Generates SAP S/4HANA **Public Cloud** cutover plans from an uploaded L4 project
plan, grounded in a local knowledge base of SAP Activate methodology, the SAP
scope-item catalog and reference cutover plans.

## What it does

Upload an L4 workplan and the agent produces a phased cutover task plan
(PRE / CUT / HC) with execution sequencing, task dependencies, per-workstream
rollback coverage and hypercare activities.

Plan quality is driven by three signals, in order of strength:

1. **Scope item IDs** in the L4 resolve against the SAP scope catalog to
   identify in-scope business areas and their master/transactional data objects.
2. **Module selection** maps to SAP Lines of Business as a fallback when the L4
   carries no scope-item column.
3. **Task content** is scanned for domain signals, so an L4 whose workstreams are
   all SAP Activate delivery tracks (EUT, KUT, OCM, Quality Gate) still yields
   Finance, Sales, Manufacturing and Supply Chain coverage.

Project Builder inputs bind into the output: countries produce statutory and tax
validation tasks, company codes produce per-entity reconciliation and sign-off,
non-SAP systems produce integration cutover and smoke tests, and the cutover
window constrains per-workstream duration budgets.

## Architecture

```
brain-extension/      Chrome extension — exports SAP Activate content from me.sap.com
brain/files/          ingested source material (gitignored — see Knowledge base)
brain/indexer.py      extractors (pdf/xlsx/pptx/html/json) + chunking + FTS5 indexing
brain/brain.db        SQLite + FTS5 index (gitignored)
brain/server.py       FastAPI backend, port 7878
brain/static/         vanilla JS SPA — app.js (UI), logic.js (business logic)
```

Claude is invoked through the local Claude CLI as a subprocess, not the
Anthropic HTTP API.

## Running it

```
brain\start.bat
```

Then open <http://localhost:7878>. Keep the window open — it is the server.

Requires Python 3.14 and the packages in `brain/requirements.txt`.

## Knowledge base

`brain/files/` and `brain/brain.db` are **not** in this repository. They contain
real client cutover plans. Build your own index by uploading material through
the Knowledge Base tab in the app.

Upload-time scrubbing removes emails, URLs, phone numbers, person names and any
client names you supply, from both chunk text and headings. Spreadsheet columns
naming people, owners or organisations are dropped before indexing.

## Scope

This tool targets SAP S/4HANA Public Cloud only. On-premise activities
(TMS/STMS, RFC destinations, Fiori backend catalog sync, BW info objects,
authorisation trace, prod-equivalent role validation) are filtered out of
generated plans.
