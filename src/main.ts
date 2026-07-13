/**
 * DS Component Audit — sandbox (Pixso API side).
 *
 * Walks every page/layer of the current file, records each component INSTANCE
 * with its origin (local vs which published library), visibility, and
 * nesting relationship. Also runs a name-based detach heuristic.
 *
 * Design notes (see project knowledge):
 *  - origin (local vs library) is the RELIABLE core. Detach-by-name and slot
 *    analysis are heuristics — kept in separate fields, never mixed into origin.
 *  - Never call importComponentByKeyAsync (crashes the sandbox).
 *  - Memory-bounded three-phase scan:
 *      Phase 1: one streaming audit + component-evidence walk.
 *      Phase 2: match the collected FRAME references against complete evidence.
 *      Phase 3: resolve library origin once per unique master with bounded I/O.
 *    No findAll* result containing hundreds of thousands of node proxies is
 *    materialized. Only matching FRAME paths are expanded after the walk.
 */

pixso.showUI(__html__, { width: 860, height: 660 });

const LIB_CONCURRENCY = 8; // parallel getLibraryInfoAsync/library fallback calls
const LIB_TIMEOUT_MS = 4000;
const RESULT_CHUNK_SIZE = 2000;

let abort = false;
// Guard against a second scan starting while one is already running. Two
// concurrent scans share the module-level abort flag and library caches and
// interleave their progress messages (the "phase 1-2-1-2 jumping" bug).
let scanning = false;

interface InstanceRecord {
  componentName: string; // set-level name (variants collapsed)
  componentKey: string | null; // set-level key when available
  variant: string | null; // the specific variant (e.g. "State=disabled") if any
  masterKey: string | null; // the specific variant master key (for library resolution)
  origin: "local" | "library" | "unknown";
  libraryName: string | null;
  libraryKey: string | null;
  visible: boolean;
  directlyVisible: boolean;
  page: string;
  layerName: string;
  depth: number;
  nestedInsideInstance: boolean;
  nestedInsideLibraryInstance: boolean;
  inheritedFromParent: boolean; // library was inherited from an ancestor lib instance
  inSlot: boolean;
  isMaster: boolean; // true = this is a COMPONENT/COMPONENT_SET master, not an instance
  parentInstanceId: string | null; // nearest ancestor INSTANCE's nodeId (for the tree view)
  nodeId: string;
}

interface DetachRecord {
  layerName: string;
  matchedComponentName: string;
  page: string;
  path: string;
  nodeId: string;
  visible: boolean; // effective visibility (this node + all ancestors)
  evidence: "file instance" | "local master" | "file instance + local master";
}

// ---------- helpers ----------

// Safe children accessor. Some nodes report `"children" in node` true but their
// .children is momentarily undefined (unloaded page, detached/proxy node). A raw
// `for..of` over that throws "Symbol.iterator of undefined" and aborts the whole
// scan — so always go through this.
function kidsOf(node: any): readonly SceneNode[] {
  const c = node && node.children;
  return c && typeof c.length === "number" ? c : [];
}

function normalizedName(value: string): string {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

// FRAME candidates are held as references during the single document walk.
// Once component evidence is complete, only actual matches pay the cost of
// reconstructing their path and effective visibility through parent links.
function readFrameContext(node: SceneNode): { page: string; path: string; visible: boolean } {
  const parts: string[] = [];
  let page = "";
  let visible = node.visible !== false;
  let parent: BaseNode | null = node.parent;
  while (parent) {
    if (parent.type === "PAGE") {
      page = parent.name;
      break;
    }
    if (parent.type === "DOCUMENT") break;
    if ((parent as any).visible === false) visible = false;
    if (typeof parent.name === "string") parts.push(parent.name);
    parent = parent.parent;
  }
  parts.reverse();
  return { page, path: parts.join(" / "), visible };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (!done) {
        done = true;
        resolve(null);
      }
    }, ms);
    p.then((v) => {
      if (!done) {
        done = true;
        clearTimeout(t);
        resolve(v);
      }
    }).catch(() => {
      if (!done) {
        done = true;
        clearTimeout(t);
        resolve(null);
      }
    });
  });
}

function yieldToUI(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

// Progress with explicit phase, current/total counts, and either a detail line
// or a set of fixed-label counters (Layers / Instances / …) the UI renders as
// stable rows with numbers growing in place (no flickering re-composed string).
function progress(
  phase: string,
  done: number,
  total: number,
  detail?: string,
  counters?: { key: string; label: string; value: number }[]
) {
  pixso.ui.postMessage({ type: "progress", phase, done, total, detail: detail || "", counters });
}

async function sendResultRows<T>(kind: "instances" | "detaches", rows: T[]): Promise<void> {
  const total = rows.length;
  for (let start = 0; start < total; start += RESULT_CHUNK_SIZE) {
    const end = Math.min(total, start + RESULT_CHUNK_SIZE);
    const chunk = rows.slice(start, end);
    // Release sandbox references as ownership moves to the UI. Keeping the
    // array length stable avoids repeated O(n) shifts during transmission.
    for (let i = start; i < end; i++) (rows as any[])[i] = null;
    pixso.ui.postMessage({ type: "resultChunk", kind, rows: chunk, done: end, total });
    progress("Preparing results", end, total, "", [
      { key: kind, label: kind === "instances" ? "Instances transferred" : "Matches transferred", value: end },
    ]);
    await yieldToUI();
  }
  rows.length = 0;
}

// A master component may itself be a variant inside a COMPONENT_SET. For audit
// purposes the unit is the SET, not the individual variant. Resolve both.
function resolveComponentIdentity(master: ComponentNode | null, fallbackName: string): {
  componentName: string;
  componentKey: string | null;
  variant: string | null;
  masterKey: string | null;
  remote: boolean;
} {
  if (!master) {
    return { componentName: fallbackName, componentKey: null, variant: null, masterKey: null, remote: false };
  }
  const parent = master.parent;
  const isVariant = parent && parent.type === "COMPONENT_SET";
  if (isVariant) {
    const set = parent as ComponentSetNode;
    return {
      componentName: set.name,
      componentKey: set.key || null,
      variant: master.name, // e.g. "State=disabled, Active=false"
      masterKey: master.key || null,
      // A variant is remote if either the set or the variant is flagged remote.
      remote: (set as any).remote === true || (master as any).remote === true,
    };
  }
  return {
    componentName: master.name,
    componentKey: master.key || null,
    variant: null,
    masterKey: master.key || null,
    remote: (master as any).remote === true,
  };
}

type ComponentIdentity = ReturnType<typeof resolveComponentIdentity>;

function resolveComponentIdentityCached(
  master: ComponentNode | null,
  fallbackName: string,
  cache: Map<string, ComponentIdentity>
): ComponentIdentity {
  if (!master) return resolveComponentIdentity(null, fallbackName);
  const cached = cache.get(master.id);
  if (cached) return cached;
  const identity = resolveComponentIdentity(master, fallbackName);
  cache.set(master.id, identity);
  return identity;
}

interface ComponentEvidenceEntry {
  displayName: string;
  fileInstance: boolean;
  localMaster: boolean;
}

type ComponentEvidenceMap = Map<string, ComponentEvidenceEntry>;

function addComponentEvidence(
  evidence: ComponentEvidenceMap,
  name: string,
  kind: "fileInstance" | "localMaster"
): void {
  const normalized = normalizedName(name);
  if (!normalized) return;
  let entry = evidence.get(normalized);
  if (!entry) {
    entry = { displayName: name.trim(), fileInstance: false, localMaster: false };
    evidence.set(normalized, entry);
  }
  entry[kind] = true;
}

interface ShallowCursor {
  children: readonly SceneNode[];
  index: number;
}

interface AuditCursor extends ShallowCursor {
  depth: number;
  parentVisible: boolean;
  ancInst: boolean;
  ancLibInst: boolean;
  libAncestor: InstanceRecord | null;
  parentInstId: string | null;
}

function isInSwapSlot(node: SceneNode): boolean {
  const refs = (node as any).componentPropertyReferences;
  return !!(refs && refs.mainComponent);
}

// ---------- library resolution (phase 2) ----------

// Reliable path: build a map of componentKey -> { libraryName, libraryKey } from
// all subscribed libraries once, then match masters by key. getLibraryInfoAsync
// is unreliable in Pixso (often empty), so this is the primary resolution.
const keyToLibrary = new Map<string, { name: string; key: string }>();
let libraryMapMeta: any = { libraries: [], componentKeys: 0, error: null };

async function buildLibraryMap(
  neededKeys: Set<string>,
  onTick?: (done: number, total: number) => void
): Promise<void> {
  const missingKeys = new Set<string>();
  neededKeys.forEach((key) => {
    if (key && !keyToLibrary.has(key)) missingKeys.add(key);
  });
  libraryMapMeta = {
    libraries: [],
    requestedKeys: neededKeys.size,
    componentKeys: keyToLibrary.size,
    unresolvedKeys: missingKeys.size,
    error: null,
  };
  if (!missingKeys.size) return;
  try {
    const list = await withTimeout<any[]>((pixso as any).getLibraryListAsync(), 15000);
    if (!list) {
      libraryMapMeta.error = "getLibraryListAsync timed out or returned null";
      return;
    }
    const subscribed = list.filter((lib) => lib && lib.subscribed);

    // Fetch with bounded concurrency and index each response immediately.
    // Retaining every payload in one Promise.all creates a large memory spike
    // before phase 3 when hundreds of libraries are subscribed.
    if (onTick) onTick(0, subscribed.length);
    await runPool(
      subscribed,
      async (lib) => {
        if (!missingKeys.size) return;
        let assets: any = null;
        try {
          assets = await withTimeout<any>((pixso as any).getLibraryByKeyAsync(lib.key), 15000);
        } catch (e) {
          assets = null;
        }

        const components = assets && assets.componentList;
        const compCount = components ? components.length : 0;
        libraryMapMeta.libraries.push({ name: lib.name, key: lib.key, subscribed: lib.subscribed, components: compCount });
        if (components) {
          for (const comp of components) {
            if (comp && comp.key && missingKeys.has(comp.key)) {
              keyToLibrary.set(comp.key, { name: lib.name, key: lib.key });
              missingKeys.delete(comp.key);
            }
            // Sets: also index each variant key.
            if (comp && comp.type === "COMPONENT_SET" && (comp as any).variants) {
              for (const v of (comp as any).variants) {
                if (v && v.key && missingKeys.has(v.key)) {
                  keyToLibrary.set(v.key, { name: lib.name, key: lib.key });
                  missingKeys.delete(v.key);
                }
              }
            }
            if (!missingKeys.size) break;
          }
        }
      },
      LIB_CONCURRENCY,
      (done, total) => { if (onTick) onTick(done, total); }
    );
    libraryMapMeta.componentKeys = keyToLibrary.size;
    libraryMapMeta.unresolvedKeys = missingKeys.size;
  } catch (e) {
    libraryMapMeta.error = String(e && (e as any).message ? (e as any).message : e);
  }
}

// Raw diagnostic dump for a single master — shows exactly what Pixso returns.
async function probeMaster(master: ComponentNode): Promise<any> {
  const parent = master.parent;
  const setKey = parent && parent.type === "COMPONENT_SET" ? (parent as ComponentSetNode).key : null;
  const out: any = {
    name: master.name,
    type: master.type,
    parentType: parent ? parent.type : null,
    remote: (master as any).remote,
    key: master.key || null,
    setKey: setKey,
    // Does the reliable key-map path find it?
    mapHitByKey: master.key ? keyToLibrary.get(master.key) || null : null,
    mapHitBySetKey: setKey ? keyToLibrary.get(setKey) || null : null,
  };
  try {
    out.libraryInfoRaw =
      typeof (master as any).getLibraryInfoAsync === "function"
        ? await withTimeout<any>((master as any).getLibraryInfoAsync(), LIB_TIMEOUT_MS)
        : "no-method";
  } catch (e) {
    out.libraryInfoErr = String(e && (e as any).message ? (e as any).message : e);
  }
  try {
    out.publishStatus =
      typeof (master as any).getPublishStatusAsync === "function"
        ? await withTimeout<any>((master as any).getPublishStatusAsync(), LIB_TIMEOUT_MS)
        : "no-method";
  } catch (e) {
    out.publishStatusErr = String(e && (e as any).message ? (e as any).message : e);
  }
  return out;
}

async function resolveLibraryForMaster(master: ComponentNode): Promise<{ name: string; key: string } | null> {
  let info: { name: string; key: string } | null = null;
  try {
    if (typeof (master as any).getLibraryInfoAsync === "function") {
      const raw = await withTimeout<any>((master as any).getLibraryInfoAsync(), LIB_TIMEOUT_MS);
      if (raw) {
        info = {
          name: raw.name || raw.libraryName || (raw.library && raw.library.name) || "(unknown library)",
          key: raw.key || raw.libraryKey || (raw.library && raw.library.key) || "",
        };
      }
    }
  } catch (e) {
    info = null;
  }
  return info;
}

// Run async tasks with bounded concurrency, reporting progress.
async function runPool<T>(
  items: T[],
  worker: (item: T, index: number) => Promise<void>,
  concurrency: number,
  onTick: (done: number, total: number) => void
): Promise<void> {
  let next = 0;
  let done = 0;
  const total = items.length;
  const runners: Promise<void>[] = [];
  const runOne = async () => {
    while (!abort) {
      const i = next++;
      if (i >= total) return;
      await worker(items[i], i);
      done++;
      onTick(done, total);
    }
  };
  for (let c = 0; c < Math.min(concurrency, total); c++) runners.push(runOne());
  await Promise.all(runners);
}

// ---------- main scan ----------

async function scan() {
  if (scanning) return; // a scan is already in flight — ignore duplicate starts
  scanning = true;
  try {
    await runScan();
  } finally {
    scanning = false;
  }
}

async function runScan() {
  abort = false;
  const tStart = Date.now();
  const timings: Record<string, number> = {};

  // Load all pages if the API supports it. On big files this single call can
  // take a while and sends no progress of its own, so set an honest status
  // first — the UI spinner keeps animating meanwhile.
  progress("Preparing", 0, 0, "Loading all pages… (can take a while on large files)");
  try {
    if (typeof (pixso as any).loadAllPagesAsync === "function") {
      await (pixso as any).loadAllPagesAsync();
    }
  } catch (e) {
    pixso.ui.postMessage({ type: "warn", message: "loadAllPagesAsync failed — scanning only loaded pages." });
  }

  const rootKids = (pixso.root && (pixso.root as any).children) || [];
  const pageSource = rootKids.length ? rootKids : (pixso.currentPage ? [pixso.currentPage] : []);
  const pages = pageSource.filter((p: any) => p && p.type === "PAGE");
  if (!pages.length) {
    pixso.ui.postMessage({ type: "error", message: "No pages to scan (file not loaded yet?). Try reopening the plugin." });
    return;
  }
  const currentFileKey = (pixso as any).fileKey || null;
  const identityCache = new Map<string, ComponentIdentity>();
  const componentEvidence: ComponentEvidenceMap = new Map();
  // One master can back hundreds of thousands of instances. Its evidence name
  // only needs normalizing once; master-less instances still use their own name.
  const evidenceMasterIds = new Set<string>();

  // ===== PHASE 1: audit + component evidence in one streaming walk =====
  // Cursor frames are O(tree depth). We never create a pending work item for
  // every sibling, which is important for very wide million-layer documents.
  progress("Phase 1/3 · scanning layers", 0, 0, "Starting…");
  const instances: InstanceRecord[] = [];
  const detaches: DetachRecord[] = [];
  const frameCandidates: FrameNode[] = [];
  // Unique masters to resolve in phase 3: masterId -> { master, records[] }
  const uniqueMasters = new Map<string, { master: ComponentNode; remote: boolean; records: InstanceRecord[] }>();
  const localMasterSamples = new Map<string, ComponentNode>();
  // Nested instances (inside a library component) whose own master doesn't resolve —
  // they inherit their nearest library ancestor's origin after phase 3 resolves it.
  const nestedToInherit: { rec: InstanceRecord; ancestor: InstanceRecord }[] = [];

  const tAudit = Date.now();
  let processed = 0;
  let checkedFrames = 0;
  let evidenceNodesScanned = 0;
  let lastYieldAt = Date.now();

  for (const page of pages) {
    if (abort) break;
    const cursors: AuditCursor[] = [{
      children: kidsOf(page),
      index: 0,
      depth: 0,
      parentVisible: true,
      ancInst: false,
      ancLibInst: false,
      libAncestor: null,
      parentInstId: null,
    }];

    while (cursors.length > 0) {
      if (abort) break;
      const cursor = cursors[cursors.length - 1];
      if (cursor.index >= cursor.children.length) {
        cursors.pop();
        continue;
      }

      const node = cursor.children[cursor.index++];
      const { depth, parentVisible, ancInst, ancLibInst, libAncestor, parentInstId } = cursor;
      const nodeType = node.type;
      processed++;

      // Effective visibility without walking up the tree: a node is visible iff
      // every ancestor is visible AND it is itself visible. We already know the
      // parent chain's visibility from the stack.
      const selfVisible = node.visible !== false;
      const effectivelyVisible = parentVisible && selfVisible;

      if (nodeType === "FRAME") {
        checkedFrames++;
        frameCandidates.push(node as FrameNode);
      } else if (nodeType === "COMPONENT" || nodeType === "COMPONENT_SET") {
        evidenceNodesScanned++;
        addComponentEvidence(componentEvidence, node.name, "localMaster");
      }

      let childAncInst = ancInst;
      let childAncLibInst = ancLibInst;
      let childLibAncestor = libAncestor;
      let childParentInstId = parentInstId;

      if (nodeType === "INSTANCE") {
        const inst = node as InstanceNode;
        const instId = inst.id;
        const instName = inst.name;
        let master: ComponentNode | null = null;
        try {
          master = inst.mainComponent;
        } catch (e) {
          master = null;
        }
        const id = resolveComponentIdentityCached(master, instName, identityCache);
        evidenceNodesScanned++;
        if (!master || !evidenceMasterIds.has(master.id)) {
          addComponentEvidence(componentEvidence, id.componentName, "fileInstance");
          if (master) evidenceMasterIds.add(master.id);
        }

        const rec: InstanceRecord = {
          componentName: id.componentName,
          componentKey: id.componentKey,
          variant: id.variant,
          masterKey: id.masterKey,
          origin: master ? "local" : "unknown", // provisional; phase 3 upgrades to "library"
          libraryName: null,
          libraryKey: null,
          visible: effectivelyVisible,
          directlyVisible: selfVisible,
          page: page.name,
          layerName: instName,
          depth,
          nestedInsideInstance: ancInst,
          nestedInsideLibraryInstance: ancLibInst,
          inheritedFromParent: false,
          inSlot: isInSwapSlot(inst),
          isMaster: false,
          parentInstanceId: parentInstId,
          nodeId: instId,
        };
        instances.push(rec);
        // Descendants of this instance point to it as their parent.
        childParentInstId = instId;

        // Queue master for phase-3 resolution (only if it looks remote).
        if (master && id.remote) {
          const key = master.id;
          let bucket = uniqueMasters.get(key);
          if (!bucket) {
            bucket = { master, remote: true, records: [] };
            uniqueMasters.set(key, bucket);
          }
          bucket.records.push(rec);
          // Only a TOP-LEVEL library instance becomes the ancestor for its
          // descendants. (A nested library instance keeps pointing at the
          // outermost library component, matching "top-level" audit logic.)
          if (!libAncestor) childLibAncestor = rec;
        } else if (master && !id.remote && localMasterSamples.size < 20) {
          if (!localMasterSamples.has(master.id)) localMasterSamples.set(master.id, master);
        }

        // Any instance nested inside a library component is a fallback candidate:
        // if its own master fails to resolve in phase 3, it inherits the ancestor.
        if (libAncestor && (!master || id.remote)) {
          nestedToInherit.push({ rec, ancestor: libAncestor });
        }

        childAncInst = true;
        if (master && id.remote) childAncLibInst = true;
      } else if (
        nodeType === "COMPONENT_SET" ||
        (nodeType === "COMPONENT" && (!node.parent || node.parent.type !== "COMPONENT_SET"))
      ) {
        // A component MASTER defined in this file (not an instance). For a
        // COMPONENT_SET we record the set once; variants (COMPONENT children of
        // a set) are skipped so we don't double-count. This is a real audit fact:
        // the file defines/uses this component even without a placed instance.
        const master = node as ComponentNode;
        const masterId = master.id;
        const masterName = master.name;
        const isRemote = (master as any).remote === true;
        const rec: InstanceRecord = {
          componentName: masterName,
          componentKey: master.key || null,
          variant: null,
          masterKey: master.key || null,
          origin: "local", // provisional; phase 3 may upgrade a remote master to library
          libraryName: null,
          libraryKey: null,
          visible: effectivelyVisible,
          directlyVisible: selfVisible,
          page: page.name,
          layerName: masterName,
          depth,
          nestedInsideInstance: ancInst,
          nestedInsideLibraryInstance: ancLibInst,
          inheritedFromParent: false,
          inSlot: false,
          isMaster: true,
          parentInstanceId: parentInstId,
          nodeId: masterId,
        };
        instances.push(rec);

        // A remote master (e.g. a library file opened directly) → resolve library.
        if (isRemote) {
          const key = masterId;
          let bucket = uniqueMasters.get(key);
          if (!bucket) { bucket = { master, remote: true, records: [] }; uniqueMasters.set(key, bucket); }
          bucket.records.push(rec);
        }
      }

      const children = "children" in node ? kidsOf(node) : [];
      if (children.length) {
        cursors.push({
          children,
          index: 0,
          depth: depth + 1,
          parentVisible: effectivelyVisible,
          ancInst: childAncInst,
          ancLibInst: childAncLibInst,
          libAncestor: childLibAncestor,
          parentInstId: childParentInstId,
        });
      }

      if (processed % 1024 === 0 && Date.now() - lastYieldAt >= 40) {
        progress("Phase 1/3 · scanning layers", processed, 0, "", [
          { key: "layers", label: "Layers", value: processed },
          { key: "instances", label: "Instances", value: instances.length },
          { key: "frames", label: "Frames checked", value: checkedFrames },
        ]);
        await yieldToUI();
        lastYieldAt = Date.now();
      }
    }
  }
  const totalNodes = processed;
  timings.phase1_scan = Date.now() - tAudit;
  progress("Phase 1/3 · scanning layers", processed, 0, "", [
    { key: "layers", label: "Layers", value: processed },
    { key: "instances", label: "Instances", value: instances.length },
    { key: "frames", label: "Frames checked", value: checkedFrames },
  ]);

  // ===== PHASE 2: apply complete evidence to collected FRAME references =====
  // This replaces the old second full-file pass. Only the actual matches walk
  // their parent chain to reconstruct path and effective visibility.
  const tDetachMatching = Date.now();
  lastYieldAt = Date.now();
  for (let i = 0; i < frameCandidates.length; i++) {
    if (abort) break;
    const node = frameCandidates[i];
    const match = componentEvidence.get(normalizedName(node.name));
    if (match) {
      const context = readFrameContext(node);
      const evidence = match.fileInstance && match.localMaster
        ? "file instance + local master"
        : match.fileInstance ? "file instance" : "local master";
      detaches.push({
        layerName: node.name,
        matchedComponentName: match.displayName,
        page: context.page,
        path: context.path,
        nodeId: node.id,
        visible: context.visible,
        evidence,
      });
    }
    if ((i + 1) % 2048 === 0 && Date.now() - lastYieldAt >= 40) {
      progress("Phase 2/3 · matching frames", i + 1, frameCandidates.length, "", [
        { key: "frames", label: "Frames checked", value: i + 1 },
        { key: "detaches", label: "Possible matches", value: detaches.length },
      ]);
      await yieldToUI();
      lastYieldAt = Date.now();
    }
  }
  progress("Phase 2/3 · matching frames", frameCandidates.length, frameCandidates.length, "", [
    { key: "frames", label: "Frames checked", value: frameCandidates.length },
    { key: "detaches", label: "Possible matches", value: detaches.length },
  ]);
  frameCandidates.length = 0;
  componentEvidence.clear();
  evidenceMasterIds.clear();
  timings.phase2_detach_matching = Date.now() - tDetachMatching;

  // ===== PHASE 3: resolve libraries for UNIQUE masters, in parallel =====
  // Diagnostics: capture raw API responses for a sample of masters so we can
  // see what Pixso actually returns (remote flag, getLibraryInfoAsync, publish
  // status) instead of guessing. Kept small so it copies cleanly.
  const diag: any = { sampleRemote: [], sampleLocal: [], resolved: 0, unresolved: 0, resolvedNames: {}, libraryMap: null };
  const tLibraries = Date.now();

  const masterBuckets = Array.from(uniqueMasters.values());
  const uniqueLibraryMastersCount = masterBuckets.length;
  const masterResolutions = masterBuckets.map((bucket) => ({
    bucket,
    setKey: null as string | null,
    info: null as { name: string; key: string } | null,
  }));

  // Resolve the masters actually used in this file first. In most files this
  // avoids downloading and indexing every subscribed library altogether.
  if (masterResolutions.length && !abort) {
    progress("Phase 3/3 · resolving libraries", 0, masterBuckets.length, "", [
      { key: "resolved", label: "Components checked", value: 0 },
    ]);
    await runPool(
      masterResolutions,
      async (resolution) => {
        const master = resolution.bucket.master;
        resolution.setKey =
          master.parent && master.parent.type === "COMPONENT_SET"
            ? (master.parent as ComponentSetNode).key
            : null;
        resolution.info = await resolveLibraryForMaster(master);
      },
      LIB_CONCURRENCY,
      (done, total) => progress("Phase 3/3 · resolving libraries", done, total, "", [
        { key: "resolved", label: "Components checked", value: done },
      ])
    );
  }

  // Only unresolved masters need the expensive library-assets fallback. Keep
  // a set of requested keys instead of building a global catalogue.
  const neededLibraryKeys = new Set<string>();
  for (const resolution of masterResolutions) {
    if (resolution.info) continue;
    const masterKey = resolution.bucket.master.key;
    if (masterKey) neededLibraryKeys.add(masterKey);
    if (resolution.setKey) neededLibraryKeys.add(resolution.setKey);
  }
  if (neededLibraryKeys.size && !abort) {
    progress("Phase 3/3 · loading fallback libraries", 0, 1, "Fetching subscribed libraries…");
    await buildLibraryMap(neededLibraryKeys, (done, total) =>
      progress("Phase 3/3 · loading fallback libraries", done, total, "", [
        { key: "libraries", label: "Libraries loaded", value: done },
      ])
    );
  } else {
    libraryMapMeta = { libraries: [], requestedKeys: 0, componentKeys: keyToLibrary.size, unresolvedKeys: 0, error: null };
  }
  diag.libraryMap = libraryMapMeta;

  for (const resolution of masterResolutions) {
    const bucket = resolution.bucket;
    const master = bucket.master;
    const info = resolution.info ||
      (master.key && keyToLibrary.get(master.key)) ||
      (resolution.setKey && keyToLibrary.get(resolution.setKey)) ||
      null;
    const pointsToCurrentFile = !!(info && currentFileKey && info.key === currentFileKey);

    if (info && info.name && !pointsToCurrentFile) {
      diag.resolved++;
      diag.resolvedNames[info.name] = (diag.resolvedNames[info.name] || 0) + bucket.records.length;
      for (const rec of bucket.records) {
        rec.origin = "library";
        rec.libraryName = info.name;
        rec.libraryKey = info.key || null;
      }
    } else if (pointsToCurrentFile) {
      diag.localCurrentFile = (diag.localCurrentFile || 0) + 1;
      for (const rec of bucket.records) {
        rec.origin = "local";
        rec.libraryName = null;
      }
    } else {
      diag.unresolved++;
      for (const rec of bucket.records) {
        rec.origin = "unknown";
        rec.libraryName = null;
      }
    }
  }

  // Keep the existing small diagnostic sample, but only after fallback keys
  // have been indexed so its map-hit fields reflect the final resolution.
  if (!abort) {
    await runPool(
      masterBuckets.slice(0, 30),
      async (bucket) => { diag.sampleRemote.push(await probeMaster(bucket.master)); },
      LIB_CONCURRENCY,
      () => {}
    );
  }
  // Probe a few non-remote masters too — to check none of them are actually library.
  if (!abort) {
    const locals = Array.from(localMasterSamples.values());
    await runPool(
      locals,
      async (m) => {
        if (diag.sampleLocal.length < 20) diag.sampleLocal.push(await probeMaster(m));
      },
      LIB_CONCURRENCY,
      () => {}
    );
  }
  // Inherit library origin for nested instances inside a library component.
  // The ancestor's origin/library is now resolved; propagate it down.
  let inherited = 0;
  for (const { rec, ancestor } of nestedToInherit) {
    // Only fill in the ones that didn't resolve on their own.
    if (rec.origin === "unknown" && ancestor.origin === "library") {
      rec.origin = "library";
      rec.libraryName = ancestor.libraryName;
      rec.libraryKey = ancestor.libraryKey;
      rec.inheritedFromParent = true;
      inherited++;
    }
  }
  diag.inheritedNested = inherited;
  timings.phase3_libraries = Date.now() - tLibraries;

  // Release duplicate record/master references before serializing the result.
  nestedToInherit.length = 0;
  masterBuckets.length = 0;
  uniqueMasters.clear();
  localMasterSamples.clear();
  identityCache.clear();
  timings.total = Date.now() - tStart;

  const fileName = (pixso.root && pixso.root.name) || "Untitled";

  // Authoritative origin breakdown computed in the sandbox (not the UI).
  const originBreakdown = { local: 0, library: 0, unknown: 0 };
  const unknownBreakdown = { masterNull: 0, nestedInLibInstance: 0, nestedInInstance: 0, topLevel: 0, notRemote: 0 };
  let placedInstanceCount = 0;
  let masterCount = 0;
  for (const r of instances) {
    originBreakdown[r.origin]++;
    if (r.isMaster) masterCount++;
    else placedInstanceCount++;
    if (r.origin === "unknown") {
      if (r.masterKey == null) unknownBreakdown.masterNull++;
      if (r.nestedInsideLibraryInstance) unknownBreakdown.nestedInLibInstance++;
      else if (r.nestedInsideInstance) unknownBreakdown.nestedInInstance++;
      else unknownBreakdown.topLevel++;
    }
  }
  diag.originBreakdown = originBreakdown;
  diag.unknownBreakdown = unknownBreakdown;

  const instanceRecordCount = instances.length;
  const detachCount = detaches.length;
  pixso.ui.postMessage({
    type: "resultStart",
    fileName,
    buildId: "BUILD-streaming-audit-v10",
    aborted: abort,
    stats: {
      totalNodes,
      instances: placedInstanceCount,
      masters: masterCount,
      records: instanceRecordCount,
      possibleMatches: detachCount,
      evidenceNodesScanned,
      evidenceStrategy: "single-streaming-pass",
      framesChecked: checkedFrames,
      uniqueLibraryMasters: uniqueLibraryMastersCount,
      timings,
    },
    diag,
  });
  await sendResultRows("instances", instances);
  await sendResultRows("detaches", detaches);
  pixso.ui.postMessage({ type: "resultEnd" });
}

// ---------- messaging ----------

pixso.ui.onmessage = (msg: any) => {
  if (!msg) return;
  if (msg.type === "scan") {
    scan().catch((e) => {
      pixso.ui.postMessage({ type: "error", message: String(e && e.message ? e.message : e) });
    });
  } else if (msg.type === "cancel") {
    abort = true;
  } else if (msg.type === "focus") {
    focusNode(msg.nodeId);
  } else if (msg.type === "thumbnail") {
    // msg: { key, nodeIds: string[] } — export a small preview of the first
    // node that renders. The UI keys previews by component key.
    exportThumbnail(msg.key, msg.nodeIds || []);
  } else if (msg.type === "resize") {
    // The UI drags an edge/corner and asks us to resize (only the sandbox can).
    var w = Math.max(360, Math.min(2000, Math.round(msg.width) || 860));
    var h = Math.max(320, Math.min(2000, Math.round(msg.height) || 660));
    pixso.ui.resize(w, h);
  } else if (msg.type === "close") {
    pixso.closePlugin();
  }
};

// Cache exported previews by component key so re-requests are instant.
const thumbnailCache = new Map<string, string>();

async function exportThumbnail(key: string, nodeIds: string[]): Promise<void> {
  const cached = thumbnailCache.get(key);
  if (cached) {
    pixso.ui.postMessage({ type: "thumbnailResult", key, dataUrl: cached });
    return;
  }
  // Try each candidate node until one exports (a deleted/odd node is skipped).
  for (const id of nodeIds) {
    try {
      const node = pixso.getNodeById(id) as any;
      if (!node || typeof node.exportAsync !== "function") continue;
      const bytes: Uint8Array = await node.exportAsync({
        format: "PNG",
        constraint: { type: "WIDTH", value: 96 }, // UI shows it at 40px (2x for retina)
      });
      if (!bytes || !bytes.length) continue;
      const b64 = (pixso as any).base64Encode
        ? (pixso as any).base64Encode(bytes)
        : bytesToBase64(bytes);
      const dataUrl = "data:image/png;base64," + b64;
      thumbnailCache.set(key, dataUrl);
      pixso.ui.postMessage({ type: "thumbnailResult", key, dataUrl });
      return;
    } catch (e) {
      /* try the next candidate */
    }
  }
  // Nothing rendered — tell the UI so it can stop showing a spinner.
  pixso.ui.postMessage({ type: "thumbnailResult", key, dataUrl: null });
}

// Fallback base64 (used only if pixso.base64Encode is unavailable).
function bytesToBase64(bytes: Uint8Array): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += chars[(n >> 18) & 63] + chars[(n >> 12) & 63] + chars[(n >> 6) & 63] + chars[n & 63];
  }
  if (i < bytes.length) {
    const rem = bytes.length - i;
    const b0 = bytes[i];
    const b1 = rem > 1 ? bytes[i + 1] : 0;
    const n = (b0 << 16) | (b1 << 8);
    out += chars[(n >> 18) & 63] + chars[(n >> 12) & 63];
    out += rem > 1 ? chars[(n >> 6) & 63] : "=";
    out += "=";
  }
  return out;
}

// Select a node and zoom the viewport to it, switching page if needed.
function focusNode(nodeId: string) {
  try {
    const node = pixso.getNodeById(nodeId) as BaseNode | null;
    if (!node) {
      pixso.ui.postMessage({ type: "focusResult", ok: false, message: "Node not found (deleted?)" });
      return;
    }
    // Walk up to the owning page.
    let owner: BaseNode | null = node;
    while (owner && owner.type !== "PAGE") owner = owner.parent;
    if (owner && owner.type === "PAGE" && pixso.currentPage !== owner) {
      pixso.currentPage = owner as PageNode;
    }
    const scene = node as SceneNode;
    pixso.currentPage.selection = [scene];
    pixso.viewport.scrollAndZoomIntoView([scene]);
    pixso.ui.postMessage({ type: "focusResult", ok: true });
  } catch (e) {
    pixso.ui.postMessage({ type: "focusResult", ok: false, message: String(e && (e as any).message ? (e as any).message : e) });
  }
}
