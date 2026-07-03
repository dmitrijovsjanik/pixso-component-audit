/**
 * DS Component Audit — sandbox (Pixso API side).
 *
 * Walks every page/layer of the current file, records each component INSTANCE
 * with its origin (local vs which published library), visibility, path, and
 * nesting relationship. Also runs a name-based detach heuristic.
 *
 * Design notes (see project knowledge):
 *  - origin (local vs library) is the RELIABLE core. Detach-by-name and slot
 *    analysis are heuristics — kept in separate fields, never mixed into origin.
 *  - Never call importComponentByKeyAsync (crashes the sandbox).
 *  - Two-phase scan for speed + visible progress:
 *      Phase 1: walk the tree, NO network. Progress by node count (smooth).
 *               Identify each instance at the COMPONENT-SET level (variants of
 *               one set collapse to one component). Collect unique master keys.
 *      Phase 2: resolve library origin ONCE per unique master (not per instance),
 *               with bounded parallelism. Progress by master count.
 *    getLibraryInfoAsync is the slow part — dedup + parallelize it.
 */

pixso.showUI(__html__, { width: 860, height: 660 });

const CHUNK_SIZE = 5000; // nodes processed before yielding. Phase 1 has no network,
// so larger chunks mean fewer cross-thread yields (each yield flushes queued
// progress messages + lets the React UI re-render — expensive on huge files).
const LIB_CONCURRENCY = 8; // parallel getLibraryInfoAsync calls in phase 2
const LIB_TIMEOUT_MS = 4000;

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
  path: string;
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

// Lazy path: instead of building a string[] for every one of the ~285k nodes,
// the walk carries an immutable linked list of ancestor names. We only
// materialize a " / "-joined string for the ~24k nodes we actually record, by
// walking this list backwards. depth is O(1) via a counter on the frame.
interface PathFrame {
  name: string;
  parent: PathFrame | null;
  depth: number;
}

function buildPath(frame: PathFrame | null): string {
  if (!frame) return "";
  const parts: string[] = [];
  let f: PathFrame | null = frame;
  while (f) {
    parts.push(f.name);
    f = f.parent;
  }
  parts.reverse();
  return parts.join(" / ");
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

function isInSwapSlot(node: SceneNode): boolean {
  const refs = (node as any).componentPropertyReferences;
  return !!(refs && refs.mainComponent);
}

// ---------- library resolution (phase 2) ----------

// Cache per master node (id) — we resolve unique masters, then map back.
const libInfoByMasterId = new Map<string, { name: string; key: string } | null>();

// Reliable path: build a map of componentKey -> { libraryName, libraryKey } from
// all subscribed libraries once, then match masters by key. getLibraryInfoAsync
// is unreliable in Pixso (often empty), so this is the primary resolution.
const keyToLibrary = new Map<string, { name: string; key: string }>();
let libraryMapBuilt = false;
let libraryMapMeta: any = { libraries: [], componentKeys: 0, error: null };

async function buildLibraryMap(
  onTick?: (done: number, total: number) => void
): Promise<void> {
  if (libraryMapBuilt) return;
  libraryMapBuilt = true;
  try {
    const list = await withTimeout<any[]>((pixso as any).getLibraryListAsync(), 15000);
    if (!list) {
      libraryMapMeta.error = "getLibraryListAsync timed out or returned null";
      return;
    }
    const subscribed = list.filter((lib) => lib && lib.subscribed);

    // Fetch all subscribed libraries in PARALLEL — getLibraryByKeyAsync is a
    // network call and doing them one-by-one was the "stuck on phase 1→2" hang.
    let done = 0;
    const total = subscribed.length;
    if (onTick) onTick(0, total);
    const fetched = await Promise.all(
      subscribed.map(async (lib) => {
        let assets: any = null;
        try {
          assets = await withTimeout<any>((pixso as any).getLibraryByKeyAsync(lib.key), 15000);
        } catch (e) {
          assets = null;
        }
        done++;
        if (onTick) onTick(done, total);
        return { lib, assets };
      })
    );

    // Indexing is sequential (Map writes) but cheap — no network here.
    for (const { lib, assets } of fetched) {
      const compCount = assets && assets.componentList ? assets.componentList.length : 0;
      libraryMapMeta.libraries.push({ name: lib.name, key: lib.key, subscribed: lib.subscribed, components: compCount });
      if (!assets || !assets.componentList) continue;
      for (const comp of assets.componentList) {
        if (comp && comp.key) keyToLibrary.set(comp.key, { name: lib.name, key: lib.key });
        // Sets: also index each variant key.
        if (comp && comp.type === "COMPONENT_SET" && (comp as any).variants) {
          for (const v of (comp as any).variants) {
            if (v && v.key) keyToLibrary.set(v.key, { name: lib.name, key: lib.key });
          }
        }
      }
    }
    libraryMapMeta.componentKeys = keyToLibrary.size;
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

  // ===== PHASE 1: walk tree, NO network =====
  // We no longer do a separate counting pass — on a 285k-node file that was a
  // full second traversal that froze the UI for no real benefit (the bar can't
  // be accurate before the walk anyway). Instead we report live counters:
  // layers processed + instances found. totalNodes is just the final tally.
  progress("Phase 1/3 · scanning", 0, 0, "Starting…");
  let totalNodes = 0;

  const instances: InstanceRecord[] = [];
  const allComponentNames = new Set<string>();
  // Unique masters to resolve in phase 2: masterId -> { master, records[] }
  const uniqueMasters = new Map<string, { master: ComponentNode; remote: boolean; records: InstanceRecord[] }>();
  const localMasterSamples = new Map<string, ComponentNode>();
  // Nested instances (inside a library component) whose own master doesn't resolve —
  // they inherit their nearest library ancestor's origin after phase 2 resolves it.
  const nestedToInherit: { rec: InstanceRecord; ancestor: InstanceRecord }[] = [];

  const tPhase1 = Date.now();
  let processed = 0;

  for (const page of pages) {
    if (abort) break;
    const stack: { node: SceneNode; pathFrame: PathFrame | null; parentVisible: boolean; ancInst: boolean; ancLibInst: boolean; libAncestor: InstanceRecord | null; parentInstId: string | null }[] = [];
    for (const child of kidsOf(page)) {
      stack.push({ node: child, pathFrame: null, parentVisible: true, ancInst: false, ancLibInst: false, libAncestor: null, parentInstId: null });
    }
    while (stack.length > 0) {
      if (abort) break;
      const { node, pathFrame, parentVisible, ancInst, ancLibInst, libAncestor, parentInstId } = stack.pop()!;
      processed++;

      // Effective visibility without walking up the tree: a node is visible iff
      // every ancestor is visible AND it is itself visible. We already know the
      // parent chain's visibility from the stack.
      const selfVisible =
        "visible" in node ? (node as SceneNode).visible : true;
      const effectivelyVisible = parentVisible && selfVisible;

      // Collect every component/set name for the detach heuristic here, during
      // the main walk — this replaces a separate full recursive traversal
      // (walkLocal) that re-visited all 285k nodes and risked a stack overflow
      // on deep trees.
      if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
        allComponentNames.add(node.name);
      }

      let childAncInst = ancInst;
      let childAncLibInst = ancLibInst;
      let childLibAncestor = libAncestor;
      let childParentInstId = parentInstId;

      if (node.type === "INSTANCE") {
        const inst = node as InstanceNode;
        let master: ComponentNode | null = null;
        try {
          master = inst.mainComponent;
        } catch (e) {
          master = null;
        }
        const id = resolveComponentIdentity(master, inst.name);
        if (id.componentName) allComponentNames.add(id.componentName);

        const rec: InstanceRecord = {
          componentName: id.componentName,
          componentKey: id.componentKey,
          variant: id.variant,
          masterKey: id.masterKey,
          origin: master ? "local" : "unknown", // provisional; phase 2 upgrades to "library"
          libraryName: null,
          libraryKey: null,
          visible: effectivelyVisible,
          directlyVisible: inst.visible,
          page: page.name,
          path: buildPath(pathFrame),
          depth: pathFrame ? pathFrame.depth : 0,
          nestedInsideInstance: ancInst,
          nestedInsideLibraryInstance: ancLibInst,
          inheritedFromParent: false,
          inSlot: isInSwapSlot(inst),
          isMaster: false,
          parentInstanceId: parentInstId,
          nodeId: inst.id,
        };
        instances.push(rec);
        // Descendants of this instance point to it as their parent.
        childParentInstId = inst.id;

        // Queue master for phase-2 resolution (only if it looks remote).
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
        // if its own master fails to resolve in phase 2, it inherits the ancestor.
        if (libAncestor) nestedToInherit.push({ rec, ancestor: libAncestor });

        childAncInst = true;
        if (master && id.remote) childAncLibInst = true;
      } else if (
        node.type === "COMPONENT_SET" ||
        (node.type === "COMPONENT" && (!node.parent || node.parent.type !== "COMPONENT_SET"))
      ) {
        // A component MASTER defined in this file (not an instance). For a
        // COMPONENT_SET we record the set once; variants (COMPONENT children of
        // a set) are skipped so we don't double-count. This is a real audit fact:
        // the file defines/uses this component even without a placed instance.
        const master = node as ComponentNode;
        const isRemote = (master as any).remote === true;
        const rec: InstanceRecord = {
          componentName: master.name,
          componentKey: master.key || null,
          variant: null,
          masterKey: master.key || null,
          origin: "local", // provisional; phase 2 may upgrade a remote master to library
          libraryName: null,
          libraryKey: null,
          visible: effectivelyVisible,
          directlyVisible: master.visible,
          page: page.name,
          path: buildPath(pathFrame),
          depth: pathFrame ? pathFrame.depth : 0,
          nestedInsideInstance: ancInst,
          nestedInsideLibraryInstance: ancLibInst,
          inheritedFromParent: false,
          inSlot: false,
          isMaster: true,
          parentInstanceId: parentInstId,
          nodeId: master.id,
        };
        instances.push(rec);
        allComponentNames.add(master.name);

        // A remote master (e.g. a library file opened directly) → resolve library.
        if (isRemote) {
          const key = master.id;
          let bucket = uniqueMasters.get(key);
          if (!bucket) { bucket = { master, remote: true, records: [] }; uniqueMasters.set(key, bucket); }
          bucket.records.push(rec);
        }
      }

      if ("children" in node) {
        // One shared frame for all children of this node (immutable, so safe to
        // share). Replaces per-child array copies (path.concat) in the hot loop.
        const childFrame: PathFrame = {
          name: node.name,
          parent: pathFrame,
          depth: (pathFrame ? pathFrame.depth : 0) + 1,
        };
        for (const kid of kidsOf(node)) {
          stack.push({ node: kid, pathFrame: childFrame, parentVisible: effectivelyVisible, ancInst: childAncInst, ancLibInst: childAncLibInst, libAncestor: childLibAncestor, parentInstId: childParentInstId });
        }
      }

      if (processed % CHUNK_SIZE === 0) {
        // Live counters, no fake percent (total=0 tells the UI to show a count).
        progress("Phase 1/3 · scanning layers", processed, 0, "", [
          { key: "layers", label: "Layers", value: processed },
          { key: "instances", label: "Instances", value: instances.length },
        ]);
        await yieldToUI();
      }
    }
  }
  totalNodes = processed;
  timings.phase1_walk = Date.now() - tPhase1;
  progress("Phase 1/3 · scanning layers", processed, 0, "", [
    { key: "layers", label: "Layers", value: processed },
    { key: "instances", label: "Instances", value: instances.length },
  ]);

  // (Component/set names for the detach heuristic are already collected during
  // the main walk above — no extra traversal needed.)

  // ===== PHASE 2: resolve libraries for UNIQUE masters, in parallel =====
  // Diagnostics: capture raw API responses for a sample of masters so we can
  // see what Pixso actually returns (remote flag, getLibraryInfoAsync, publish
  // status) instead of guessing. Kept small so it copies cleanly.
  const diag: any = { sampleRemote: [], sampleLocal: [], resolved: 0, unresolved: 0, resolvedNames: {}, libraryMap: null };
  const tPhase2 = Date.now();

  // Build the reliable key->library map ONCE before resolving masters.
  progress("Phase 2/3 · loading libraries", 0, 1, "Fetching subscribed libraries…");
  await buildLibraryMap((done, total) =>
    progress("Phase 2/3 · loading libraries", done, total, "", [
      { key: "libraries", label: "Libraries loaded", value: done },
    ])
  );
  diag.libraryMap = libraryMapMeta;

  const masterBuckets = Array.from(uniqueMasters.values());
  if (masterBuckets.length && !abort) {
    progress("Phase 2/3 · resolving libraries", 0, masterBuckets.length, "", [
      { key: "resolved", label: "Components checked", value: 0 },
    ]);
    await runPool(
      masterBuckets,
      async (bucket) => {
        const master = bucket.master;
        const setKey =
          master.parent && master.parent.type === "COMPONENT_SET"
            ? (master.parent as ComponentSetNode).key
            : null;

        // PRIMARY: getLibraryInfoAsync — diagnostics showed it resolves most
        // components (including many the key-map misses).
        let info: { name: string; key: string } | null = await resolveLibraryForMaster(master);
        // ADDITIVE: key-map catches the rest that getLibraryInfoAsync leaves null.
        if (!info) {
          info =
            (master.key && keyToLibrary.get(master.key)) ||
            (setKey && keyToLibrary.get(setKey)) ||
            null;
        }

        libInfoByMasterId.set(master.id, info);

        if (diag.sampleRemote.length < 30) {
          diag.sampleRemote.push(await probeMaster(master));
        }

        // A libraryInfo pointing at the CURRENT file is NOT a DS library — it's local.
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
      },
      LIB_CONCURRENCY,
      (done, total) => progress("Phase 2/3 · resolving libraries", done, total, "", [
        { key: "resolved", label: "Components checked", value: done },
      ])
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
  timings.phase2_libraries = Date.now() - tPhase2;

  // ===== PHASE 3: detach heuristic (cheap) =====
  const tPhase3 = Date.now();
  const detaches: DetachRecord[] = [];
  if (!abort) {
    progress("Phase 3/3 · detach heuristic", 0, 0, "Matching layer names…");
    const nameSet = new Set(Array.from(allComponentNames).map((n) => n.toLowerCase()));
    let scanned = 0;
    for (const page of pages) {
      if (abort) break;
      const stack: { node: SceneNode; pathFrame: PathFrame | null; parentVisible: boolean }[] = [];
      for (const child of kidsOf(page)) stack.push({ node: child, pathFrame: null, parentVisible: true });
      while (stack.length > 0) {
        if (abort) break;
        const { node, pathFrame, parentVisible } = stack.pop()!;
        scanned++;
        const selfVisible = "visible" in node ? (node as SceneNode).visible : true;
        const effectivelyVisible = parentVisible && selfVisible;
        const isContainerLike = node.type === "FRAME" || node.type === "GROUP" || node.type === "COMPONENT";
        if (isContainerLike && nameSet.has(node.name.toLowerCase())) {
          detaches.push({
            layerName: node.name,
            matchedComponentName: node.name,
            page: page.name,
            path: buildPath(pathFrame),
            nodeId: node.id,
            visible: effectivelyVisible,
          });
        }
        if ("children" in node) {
          const childFrame: PathFrame = {
            name: node.name,
            parent: pathFrame,
            depth: (pathFrame ? pathFrame.depth : 0) + 1,
          };
          for (const kid of kidsOf(node)) stack.push({ node: kid, pathFrame: childFrame, parentVisible: effectivelyVisible });
        }
        // Keep the UI alive during this ~285k-node pass.
        if (scanned % CHUNK_SIZE === 0) {
          progress("Phase 3/3 · detach heuristic", scanned, 0, "", [
            { key: "detaches", label: "Possible detaches", value: detaches.length },
          ]);
          await yieldToUI();
        }
      }
    }
  }
  timings.phase3_detach = Date.now() - tPhase3;
  timings.total = Date.now() - tStart;

  const fileName = (pixso.root && pixso.root.name) || "Untitled";

  // Authoritative origin breakdown computed in the sandbox (not the UI).
  const originBreakdown = { local: 0, library: 0, unknown: 0 };
  const unknownBreakdown = { masterNull: 0, nestedInLibInstance: 0, nestedInInstance: 0, topLevel: 0, notRemote: 0 };
  for (const r of instances) {
    originBreakdown[r.origin]++;
    if (r.origin === "unknown") {
      if (r.masterKey == null) unknownBreakdown.masterNull++;
      if (r.nestedInsideLibraryInstance) unknownBreakdown.nestedInLibInstance++;
      else if (r.nestedInsideInstance) unknownBreakdown.nestedInInstance++;
      else unknownBreakdown.topLevel++;
    }
  }
  diag.originBreakdown = originBreakdown;
  diag.unknownBreakdown = unknownBreakdown;

  pixso.ui.postMessage({
    type: "result",
    fileName,
    buildId: "BUILD-resize-v6",
    instances,
    detaches,
    aborted: abort,
    stats: {
      totalNodes,
      instances: instances.length,
      uniqueLibraryMasters: masterBuckets.length,
      timings,
    },
    diag,
  });
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
