import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Loading01Icon } from "@hugeicons/core-free-icons";
import type { ProgressCounter } from "@/lib/types";

export interface ProgressInfo {
  phase: string;
  detail: string;
  counters?: ProgressCounter[];
}

function fmt(n: number): string {
  // Thousands separator; tabular-nums keeps digit width fixed so numbers grow
  // in place without the row jittering.
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

// A single counter row: static label, number that updates in place.
function Counter({ label, value }: ProgressCounter) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold tabular-nums">{fmt(value)}</span>
    </div>
  );
}

// Live scan status. Instead of a re-composed string (which flickered), it shows
// a spinner, the phase, an elapsed timer, and a small set of fixed-label
// counters whose numbers grow in place. The spinner + timer are UI-driven, so
// they stay alive even while the sandbox is busy in one long await.
export function ScanProgress({
  scanning,
  progress,
  warn,
}: {
  scanning: boolean;
  progress: ProgressInfo | null;
  warn: string | null;
}) {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number>(0);

  useEffect(() => {
    if (!scanning) return;
    startRef.current = Date.now();
    setElapsed(0);
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [scanning]);

  if (!scanning) {
    return warn ? (
      <div className="px-3.5 py-1 text-muted-foreground">⚠ {warn}</div>
    ) : null;
  }

  const counters = progress?.counters || [];

  return (
    <div className="mx-3.5 my-2 rounded-lg border bg-card p-4">
      <div className="flex items-center gap-2.5">
        <HugeiconsIcon
          icon={Loading01Icon}
          size={18}
          className="shrink-0 animate-spin text-primary"
        />
        <span className="flex-1 font-medium">
          {progress?.phase || "Starting…"}
        </span>
        <span className="tabular-nums text-muted-foreground">{elapsed}s</span>
      </div>

      {counters.length > 0 && (
        <div className="mt-3 space-y-1 text-sm">
          {counters.map((c) => (
            <Counter key={c.label} label={c.label} value={c.value} />
          ))}
        </div>
      )}
      {!counters.length && progress?.detail && (
        <div className="mt-2 text-muted-foreground">{progress.detail}</div>
      )}

      {warn && (
        <div className="mt-2 border-t pt-2 text-muted-foreground">⚠ {warn}</div>
      )}
    </div>
  );
}
