import type { ScanResult } from "./types";
import { visibleInstances, type Filters } from "./audit";

// Flat, export-ready rows. Respect the same filters as the on-screen view so
// the export matches what the user sees.
export function instanceRows(res: ScanResult, f: Filters) {
  return visibleInstances(res, f).map((r) => ({
    Component: r.componentName,
    ComponentKey: r.componentKey || "",
    Variant: r.variant || "",
    MasterKey: r.masterKey || "",
    Kind: r.isMaster ? "master" : "instance",
    Source:
      r.origin === "library"
        ? r.libraryName || "(unknown library)"
        : r.origin === "local"
          ? "local"
          : "unresolved",
    Origin: r.origin,
    Library: r.libraryName || "",
    LibraryKey: r.libraryKey || "",
    EffectivelyVisible: r.visible ? "yes" : "no",
    DirectlyVisible: r.directlyVisible ? "yes" : "no",
    NestedInsideInstance: r.nestedInsideInstance ? "yes" : "no",
    NestedInsideLibraryInstance: r.nestedInsideLibraryInstance ? "yes" : "no",
    LibraryInheritedFromParent: r.inheritedFromParent ? "yes" : "no",
    InSwapSlot: r.inSlot ? "yes" : "no",
    Depth: r.depth,
    Page: r.page,
    Path: r.path,
    File: res.fileName,
  }));
}

export function detachRows(res: ScanResult) {
  return res.detaches.map((r) => ({
    Layer: r.layerName,
    MatchedComponent: r.matchedComponentName,
    Page: r.page,
    Path: r.path,
    File: res.fileName,
  }));
}

function toCSV(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const q = (v: unknown) => {
    const s = String(v == null ? "" : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const out = [cols.join(",")];
  rows.forEach((r) => out.push(cols.map((c) => q(r[c])).join(",")));
  return out.join("\n");
}

function download(name: string, content: Blob | string, mime?: string) {
  const blob =
    content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}

function safeFile(res: ScanResult): string {
  return (res.fileName || "audit").replace(/[^\w.-]+/g, "_");
}

export function exportCSV(res: ScanResult, f: Filters) {
  const base = safeFile(res);
  download(base + "__instances.csv", toCSV(instanceRows(res, f)), "text/csv");
  if (res.detaches.length) {
    setTimeout(
      () =>
        download(
          base + "__detach.csv",
          toCSV(detachRows(res) as Record<string, unknown>[]),
          "text/csv"
        ),
      200
    );
  }
}

// ---- minimal .xlsx writer ----
// We only need two sheets of flat string rows — no formulas, styles, or images —
// so a tiny hand-rolled OOXML writer replaces ExcelJS (~1.3MB → ~0KB).

function xmlEscape(v: unknown): string {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function colName(i: number): string {
  let s = "";
  i++;
  while (i > 0) {
    const m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

// One worksheet XML. All cells are inline strings (t="inlineStr") — avoids a
// shared-strings table. Numbers are written as strings too; fine for an audit.
function sheetXml(rows: Record<string, unknown>[]): string {
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const cell = (r: number, c: number, val: unknown) =>
    `<c r="${colName(c)}${r}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(
      val
    )}</t></is></c>`;
  const lines: string[] = [];
  // header row
  lines.push(
    `<row r="1">${cols.map((c, ci) => cell(1, ci, c)).join("")}</row>`
  );
  rows.forEach((row, ri) => {
    const r = ri + 2;
    lines.push(
      `<row r="${r}">${cols
        .map((c, ci) => cell(r, ci, row[c]))
        .join("")}</row>`
    );
  });
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${lines.join("")}</sheetData></worksheet>`
  );
}

export async function exportXLSX(res: ScanResult, f: Filters) {
  const { MiniZip } = await import("./minizip");
  const sheets = [
    { name: "Instances", rows: instanceRows(res, f) as Record<string, unknown>[] },
    { name: "Detach", rows: detachRows(res) as Record<string, unknown>[] },
  ];

  const zip = new MiniZip();
  zip.add(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      sheets
        .map(
          (_, i) =>
            `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
        )
        .join("") +
      `</Types>`
  );
  zip.add(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`
  );
  zip.add(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<sheets>` +
      sheets
        .map(
          (s, i) =>
            `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`
        )
        .join("") +
      `</sheets></workbook>`
  );
  zip.add(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      sheets
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
        )
        .join("") +
      `</Relationships>`
  );
  sheets.forEach((s, i) =>
    zip.add(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.rows))
  );

  download(safeFile(res) + "__audit.xlsx", zip.toBlob());
}
