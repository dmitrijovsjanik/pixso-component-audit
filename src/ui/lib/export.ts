import ExcelJS from "exceljs";
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

function addSheet(
  wb: ExcelJS.Workbook,
  name: string,
  rows: Record<string, unknown>[]
) {
  const ws = wb.addWorksheet(name);
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  ws.columns = cols.map((c) => ({ header: c, key: c, width: 18 }));
  rows.forEach((r) => ws.addRow(r));
  ws.getRow(1).font = { bold: true };
}

export async function exportXLSX(res: ScanResult, f: Filters) {
  const wb = new ExcelJS.Workbook();
  addSheet(wb, "Instances", instanceRows(res, f));
  addSheet(wb, "Detach", detachRows(res) as Record<string, unknown>[]);
  const buf = await wb.xlsx.writeBuffer();
  download(
    safeFile(res) + "__audit.xlsx",
    new Blob([buf], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    })
  );
}
