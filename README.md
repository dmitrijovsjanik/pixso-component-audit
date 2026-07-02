# DS Component Audit (Pixso plugin)

Automates the yearly design-system audit: instead of a designer manually searching
each file page-by-page for components, this plugin walks the whole open file, records
every component instance, and exports a structured table (CSV + XLSX) for assembling
the year-over-year audit.

## What it records per instance

- **Master name / key**
- **Origin** — `local` (master lives in this file) vs `library` (published DS library). This is the reliable core.
- **Library name / key** — which library the instance comes from (origin as a property, not a filter).
- **Visibility** — effective (parent chain) and direct.
- **Nesting** — is it inside another instance? inside a *library* instance? (top-level vs part-of-a-master)
- **Slot** — heuristic flag: instance sits in a swap slot of its parent.
- **Page / path / file** — so exports from many files merge mechanically into one table.

Plus a separate **Detach (heuristic)** sheet: non-instance layers whose name matches a
known component. Name-based only — expect false positives. Never mixed into origin.

## Known limits (honest)

- **One file per run.** A plugin can't reach other files in the project. Run per file; each
  export carries its file name so you concatenate them in Sheets/AI afterwards.
- **Google Sheets** can't be written directly (needs OAuth). Export CSV/XLSX → import.
- **All-pages scan** depends on `loadAllPagesAsync` being available in the Pixso build —
  guarded; falls back to loaded pages with a warning.
- **Origin detection** relies on `mainComponent.remote` + `getLibraryInfoAsync()`. Verified in
  Figma; **verify the exact shape on first Pixso run** (the plugin captures fields defensively).

## Build

```bash
npm install
npm run build   # → dist/main.js
```

Load in Pixso: Plugins → Development → Import from manifest → `manifest.json`.

## Status

v0.1 — full first pass: origin registry + nesting + slot flag + detach heuristic + CSV/XLSX.
Not yet verified against a live Pixso file — the API assumptions above need a real run.
