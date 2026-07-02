import type {
  InstanceRecord,
  ScanResult,
  SortDir,
  SortKey,
} from "./types";

export interface Filters {
  showHidden: boolean;
  showNested: boolean;
  search: string;
  origin: string;
  library: string;
}

// Instances honoring all filters — hidden/nested toggles, search, origin, lib.
// Default audit view: visible + top-level only.
export function visibleInstances(
  res: ScanResult,
  f: Filters
): InstanceRecord[] {
  const q = f.search.toLowerCase();
  return res.instances.filter((r) => {
    if (!f.showHidden && !r.visible) return false;
    if (!f.showNested && r.nestedInsideInstance) return false;
    if (f.origin && r.origin !== f.origin) return false;
    if (f.library && (r.libraryName || "") !== f.library) return false;
    if (q && r.componentName.toLowerCase().indexOf(q) === -1) return false;
    return true;
  });
}

// The audit scope (hidden/nested toggles only) — used to populate the library
// dropdown and the "X of Y" count, independent of search/origin/lib.
export function scopedInstances(
  res: ScanResult,
  f: Filters
): InstanceRecord[] {
  return res.instances.filter((r) => {
    if (!f.showHidden && !r.visible) return false;
    if (!f.showNested && r.nestedInsideInstance) return false;
    return true;
  });
}

export function libraryNames(res: ScanResult, f: Filters): string[] {
  const names: Record<string, 1> = {};
  scopedInstances(res, f).forEach((r) => {
    if (r.origin === "library" && r.libraryName) names[r.libraryName] = 1;
  });
  return Object.keys(names).sort();
}

// ---- grouping: Component (set) -> Variant -> instances ----

export interface VariantGroup {
  name: string;
  count: number;
  items: InstanceRecord[];
}

export interface CompGroup {
  key: string;
  name: string;
  origin: InstanceRecord["origin"];
  library: string | null;
  hasMaster: boolean;
  hasInstance: boolean;
  count: number;
  variants: Record<string, VariantGroup>;
  variantOrder: string[];
}

export function groupInstances(rows: InstanceRecord[]): CompGroup[] {
  const byComp: Record<string, CompGroup> = {};
  const order: string[] = [];
  rows.forEach((r) => {
    const ck = r.componentKey || r.componentName;
    if (!byComp[ck]) {
      byComp[ck] = {
        key: ck,
        name: r.componentName,
        origin: r.origin,
        library: r.libraryName,
        hasMaster: false,
        hasInstance: false,
        count: 0,
        variants: {},
        variantOrder: [],
      };
      order.push(ck);
    }
    const g = byComp[ck];
    g.count++;
    if (r.isMaster) g.hasMaster = true;
    else g.hasInstance = true;
    if (r.origin === "library") {
      g.origin = "library";
      g.library = r.libraryName;
    }
    const vk = r.variant || "(no variants)";
    if (!g.variants[vk]) {
      g.variants[vk] = { name: vk, count: 0, items: [] };
      g.variantOrder.push(vk);
    }
    g.variants[vk].count++;
    g.variants[vk].items.push(r);
  });
  return order.map((k) => byComp[k]);
}

export function sourceLabel(g: {
  origin: InstanceRecord["origin"];
  library?: string | null;
}): string {
  if (g.origin === "library") return g.library || "(unknown library)";
  if (g.origin === "local") return "local";
  return "unresolved";
}

export function sortGroups(
  groups: CompGroup[],
  sortKey: SortKey,
  sortDir: SortDir
): CompGroup[] {
  const dir = sortDir;
  return groups.slice().sort((a, b) => {
    let av: string | number;
    let bv: string | number;
    if (sortKey === "count") {
      av = a.count;
      bv = b.count;
    } else if (sortKey === "source") {
      av = sourceLabel(a).toLowerCase();
      bv = sourceLabel(b).toLowerCase();
    } else {
      av = (a.name || "").toLowerCase();
      bv = (b.name || "").toLowerCase();
    }
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    // Stable secondary sort: always name A->Z.
    const an = (a.name || "").toLowerCase();
    const bn = (b.name || "").toLowerCase();
    if (an < bn) return -1;
    if (an > bn) return 1;
    return 0;
  });
}

// ---- tree view: real nesting ----

export interface TreeNode {
  rec: InstanceRecord;
  children: TreeNode[];
}

export function buildTree(res: ScanResult, f: Filters): TreeNode[] {
  const q = f.search.toLowerCase();
  const pool = res.instances.filter((r) => {
    if (!f.showHidden && !r.visible) return false;
    if (f.origin && r.origin !== f.origin) return false;
    if (f.library && (r.libraryName || "") !== f.library) return false;
    return true;
  });

  const byId: Record<string, InstanceRecord> = {};
  pool.forEach((r) => {
    byId[r.nodeId] = r;
  });
  const childrenOf: Record<string, InstanceRecord[]> = {};
  pool.forEach((r) => {
    const p = r.parentInstanceId;
    const pkey = p && byId[p] ? p : "__root__";
    (childrenOf[pkey] = childrenOf[pkey] || []).push(r);
  });

  const sortByName = (a: InstanceRecord, b: InstanceRecord) => {
    const an = a.componentName.toLowerCase();
    const bn = b.componentName.toLowerCase();
    return an < bn ? -1 : an > bn ? 1 : 0;
  };

  let roots = (childrenOf["__root__"] || []).slice();
  if (q)
    roots = roots.filter(
      (r) => r.componentName.toLowerCase().indexOf(q) !== -1
    );
  roots.sort(sortByName);

  const build = (r: InstanceRecord): TreeNode => {
    const kids = (childrenOf[r.nodeId] || []).slice().sort(sortByName);
    return { rec: r, children: kids.map(build) };
  };
  return roots.map(build);
}

// ---- summary numbers ----

export interface Summary {
  uniqCount: number;
  instances: number;
  lib: number;
  loc: number;
  unk: number;
  libCount: number;
}

export function summarize(res: ScanResult, f: Filters): Summary {
  const inst = visibleInstances(res, f);
  const lib = inst.filter((r) => r.origin === "library").length;
  const loc = inst.filter((r) => r.origin === "local").length;
  const unk = inst.filter((r) => r.origin === "unknown").length;
  const uniqComp: Record<string, 1> = {};
  const libNames: Record<string, 1> = {};
  inst.forEach((r) => {
    uniqComp[r.componentKey || r.componentName] = 1;
    if (r.origin === "library" && r.libraryName) libNames[r.libraryName] = 1;
  });
  return {
    uniqCount: Object.keys(uniqComp).length,
    instances: inst.length,
    lib,
    loc,
    unk,
    libCount: Object.keys(libNames).length,
  };
}
