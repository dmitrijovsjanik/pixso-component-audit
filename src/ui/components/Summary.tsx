import { summarize, type Filters } from "@/lib/audit";
import type { ScanResult } from "@/lib/types";

function ms(v: number | null | undefined): string {
  if (v == null) return "?";
  return v < 1000 ? v + "ms" : (v / 1000).toFixed(1) + "s";
}

export function Summary({
  result,
  filters,
}: {
  result: ScanResult;
  filters: Filters;
}) {
  const s = summarize(result, filters);
  const scopeNote: string[] = [];
  if (!filters.showNested) scopeNote.push("top-level");
  if (!filters.showHidden) scopeNote.push("visible");
  const scopeStr = scopeNote.length ? ` (${scopeNote.join(", ")} only)` : "";

  const t = result.stats?.timings;

  return (
    <div className="px-3.5 pt-1 text-muted-foreground">
      <div>
        <b className="text-foreground">{s.uniqCount}</b> components used across{" "}
        <b className="text-foreground">{s.instances}</b> instances{scopeStr}.{" "}
        Sources: <b className="text-foreground">{s.lib}</b> from {s.libCount} DS{" "}
        {s.libCount === 1 ? "library" : "libraries"} ·{" "}
        <b className="text-foreground">{s.loc}</b> local
        {s.unk ? (
          <>
            {" "}
            · <b className="text-foreground">{s.unk}</b> unresolved
          </>
        ) : null}{" "}
        · <b className="text-foreground">{result.detaches.length}</b> possible
        detaches
        {result.aborted && (
          <span className="text-destructive"> (cancelled — partial)</span>
        )}
      </div>
      {t && (
        <div className="mt-0.5 text-[11px]">
          scanned {result.stats?.totalNodes || 0} layers · walk{" "}
          {ms(t.phase1_walk)} · libraries {ms(t.phase2_libraries)} (
          {result.stats?.uniqueLibraryMasters || 0} checked) · detach{" "}
          {ms(t.phase3_detach)} ·{" "}
          <b className="text-foreground">total {ms(t.total)}</b>
        </div>
      )}
    </div>
  );
}
