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

## UI stack

The plugin UI is a **React + TypeScript** app styled with **Tailwind CSS v4** and
**shadcn/ui** components, with **Hugeicons** (`@hugeicons/react` + free icon set) for icons.
Vite bundles it into a single self-contained `dist/ui.html` (via `vite-plugin-singlefile`)
because Pixso loads the plugin UI as one raw HTML file in an iframe — no external files,
no CDN. XLSX export uses **ExcelJS** (the abandoned `xlsx`/SheetJS npm package was dropped
for its known vulnerabilities).

The sandbox (`src/main.ts`) is unchanged and still compiles with `tsc` → `dist/main.js`.
UI↔sandbox message-passing keeps the original `postMessage` protocol.

## Build

```bash
npm install
npm run build          # sandbox (tsc → dist/main.js) + UI (vite → dist/ui.html)

# or individually:
npm run build:sandbox  # tsc → dist/main.js
npm run build:ui       # vite → dist/ui.html
npm run watch:ui       # vite --watch during UI development
```

Load in Pixso: Plugins → Development → Import from manifest → `manifest.json`.

`dist/` is git-ignored — run `npm install && npm run build` after cloning before importing.

## Status

v0.1 — full first pass: origin registry + nesting + slot flag + detach heuristic + CSV/XLSX.
Not yet verified against a live Pixso file — the API assumptions above need a real run.
