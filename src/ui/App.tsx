import { useCallback, useEffect, useMemo, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  PlayCircle02Icon,
  StopCircleIcon,
  FileExportIcon,
  Table01Icon,
  Bug01Icon,
  Copy01Icon,
  Cancel01Icon,
  Layers01Icon,
} from "@hugeicons/core-free-icons";
import { Button } from "./components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./components/ui/tabs";
import { ScanProgress } from "./components/ScanProgress";
import { FilterBar } from "./components/FilterBar";
import { Summary } from "./components/Summary";
import { InstancesTable } from "./components/InstancesTable";
import { DetachTable } from "./components/DetachTable";
import { post, useSandboxMessages } from "./lib/messaging";
import {
  libraryNames,
  scopedInstances,
  visibleInstances,
  type Filters,
} from "./lib/audit";
import { exportCSV, exportXLSX } from "./lib/export";
import type {
  IncomingMsg,
  ScanResult,
  SortDir,
  SortKey,
  ViewMode,
} from "./lib/types";

const INITIAL_FILTERS: Filters = {
  showHidden: false,
  showNested: false,
  search: "",
  origin: "",
  libraries: [],
};

export default function App() {
  const [result, setResult] = useState<ScanResult | null>(null);
  // Progress/warn live in <ScanProgress> so their high-frequency updates don't
  // re-render App (which holds the heavy tables). App tracks only whether a scan
  // is in flight, to toggle the Scan/Cancel buttons.
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [filters, setFiltersState] = useState<Filters>(INITIAL_FILTERS);
  const [viewMode, setViewMode] = useState<ViewMode>("flat");
  const [sortKey, setSortKey] = useState<SortKey>("count");
  const [sortDir, setSortDir] = useState<SortDir>(-1);

  const [tab, setTab] = useState<"instances" | "detach">("instances");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notFoundId, setNotFoundId] = useState<string | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [copyLabel, setCopyLabel] = useState("Copy");

  const setFilters = useCallback(
    (patch: Partial<Filters>) =>
      setFiltersState((f) => ({ ...f, ...patch })),
    []
  );

  const onSort = useCallback((key: SortKey) => {
    setSortKey((prevKey) => {
      if (prevKey === key) {
        setSortDir((d) => (-d as SortDir));
        return prevKey;
      }
      setSortDir(key === "count" ? -1 : 1);
      return key;
    });
  }, []);

  // App only reacts to terminal messages (result/error) + focus results — all
  // low-frequency. Progress/warn are handled inside <ScanProgress>.
  const handleMessage = useCallback((msg: IncomingMsg) => {
    if (msg.type === "focusResult") {
      if (!msg.ok) {
        setSelectedId((cur) => {
          if (cur) {
            setNotFoundId(cur);
            setTimeout(() => setNotFoundId(null), 1500);
          }
          return cur;
        });
      }
    } else if (msg.type === "error") {
      setScanning(false);
      setError(msg.message);
    } else if (msg.type === "result") {
      setScanning(false);
      setError(null);
      setResult(msg);
    }
  }, []);

  useSandboxMessages(handleMessage);

  const startScan = () => {
    setScanning(true);
    setError(null);
    post({ type: "scan" });
  };

  const onFocus = (nodeId: string) => {
    setSelectedId(nodeId);
    setNotFoundId(null);
    post({ type: "focus", nodeId });
  };

  const libraries = useMemo(
    () => (result ? libraryNames(result, filters) : []),
    [result, filters]
  );

  // Drop selected libraries that no longer exist in scope (e.g. after a new scan
  // or a scope-changing toggle), so the filter doesn't hide everything silently.
  useEffect(() => {
    setFiltersState((f) => {
      if (!f.libraries.length) return f;
      const pruned = f.libraries.filter((n) => libraries.indexOf(n) !== -1);
      return pruned.length === f.libraries.length
        ? f
        : { ...f, libraries: pruned };
    });
  }, [libraries]);

  const { shown, total } = useMemo(() => {
    if (!result) return { shown: 0, total: 0 };
    return {
      shown: visibleInstances(result, filters).length,
      total: scopedInstances(result, filters).length,
    };
  }, [result, filters]);

  const hasData =
    !!result && (result.instances.length > 0 || result.detaches.length > 0);

  const debugText = useMemo(() => {
    if (!result) return "no data yet — run a scan first";
    const originCounts = { local: 0, library: 0, unknown: 0 };
    result.instances.forEach((r) => {
      originCounts[r.origin] = (originCounts[r.origin] || 0) + 1;
    });
    return JSON.stringify(
      {
        buildId: result.buildId || "(no buildId — OLD BUILD RUNNING)",
        fileName: result.fileName,
        stats: result.stats,
        diag: result.diag,
        originCounts,
      },
      null,
      2
    );
  }, [result]);

  const copyDebug = async () => {
    setShowDebug(true);
    let ok = false;
    try {
      await navigator.clipboard.writeText(debugText);
      ok = true;
    } catch {
      ok = false;
    }
    setCopyLabel(ok ? "Copied!" : "Select ↑ & Cmd+C");
    setTimeout(() => setCopyLabel("Copy"), 1600);
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* Header */}
      <header className="flex items-center gap-2 border-b px-3.5 py-3">
        <HugeiconsIcon icon={Layers01Icon} size={16} className="text-primary" />
        <h1 className="flex-1 text-[13px] font-semibold">DS Component Audit</h1>
        {result && (
          <span className="truncate text-[11px] text-muted-foreground">
            {result.buildId ? `[${result.buildId}] ` : "[OLD BUILD] "}
            {result.fileName}
          </span>
        )}
      </header>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 px-3.5 py-2.5">
        <Button onClick={startScan} disabled={scanning}>
          <HugeiconsIcon icon={PlayCircle02Icon} size={14} />
          Scan file
        </Button>
        <Button
          variant="destructive"
          onClick={() => post({ type: "cancel" })}
          disabled={!scanning}
        >
          <HugeiconsIcon icon={StopCircleIcon} size={14} />
          Cancel
        </Button>
        <div className="flex-1" />
        <Button
          variant="outline"
          onClick={() => result && exportCSV(result, filters)}
          disabled={!hasData}
        >
          <HugeiconsIcon icon={FileExportIcon} size={14} />
          Export CSV
        </Button>
        <Button
          variant="outline"
          onClick={() => result && exportXLSX(result, filters)}
          disabled={!hasData}
        >
          <HugeiconsIcon icon={Table01Icon} size={14} />
          Export XLSX
        </Button>
      </div>

      {/* Progress (owns its own high-frequency state) */}
      <ScanProgress scanning={scanning} />

      {error && (
        <div className="px-3.5 py-1 text-destructive">Error: {error}</div>
      )}

      {result && <Summary result={result} filters={filters} />}

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-auto">
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as "instances" | "detach")}
          className="pt-2"
        >
          <div className="px-3.5">
            <TabsList>
              <TabsTrigger value="instances">Instances</TabsTrigger>
              <TabsTrigger value="detach">Detach (heuristic)</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="instances" className="mt-2">
            {!result ? (
              <EmptyState text='No scan yet. Click "Scan file".' />
            ) : (
              <>
                <FilterBar
                  filters={filters}
                  setFilters={setFilters}
                  libraries={libraries}
                  viewMode={viewMode}
                  setViewMode={setViewMode}
                  shown={shown}
                  total={total}
                />
                <InstancesTable
                  result={result}
                  filters={filters}
                  viewMode={viewMode}
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={onSort}
                  selectedId={selectedId}
                  notFoundId={notFoundId}
                  onFocus={onFocus}
                />
              </>
            )}
          </TabsContent>

          <TabsContent value="detach" className="mt-2">
            <div className="px-3.5 py-1.5 text-[11px] italic text-muted-foreground">
              Name-based match only — a layer that is NOT an instance but whose
              name matches a known component. May include false positives.
            </div>
            <DetachTable
              rows={result?.detaches || []}
              selectedId={selectedId}
              notFoundId={notFoundId}
              onFocus={onFocus}
            />
          </TabsContent>
        </Tabs>

        {showDebug && (
          <div className="px-3.5 pb-2.5">
            <div className="mb-1 text-muted-foreground">
              Diagnostic (select all &amp; copy):
            </div>
            <textarea
              readOnly
              value={debugText}
              className="h-40 w-full resize-y rounded-md border bg-muted/30 p-2 font-mono text-[11px]"
            />
          </div>
        )}
      </div>

      {/* Footer */}
      <footer className="flex items-center gap-2 border-t px-3.5 py-2.5">
        <Button variant="ghost" onClick={() => setShowDebug((s) => !s)}>
          <HugeiconsIcon icon={Bug01Icon} size={14} />
          {showDebug ? "Hide debug" : "Show debug"}
        </Button>
        <Button variant="ghost" onClick={copyDebug}>
          <HugeiconsIcon icon={Copy01Icon} size={14} />
          {copyLabel}
        </Button>
        <div className="flex-1" />
        <Button variant="secondary" onClick={() => post({ type: "close" })}>
          <HugeiconsIcon icon={Cancel01Icon} size={14} />
          Close
        </Button>
      </footer>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="px-3.5 py-8 text-center text-muted-foreground">{text}</div>
  );
}
