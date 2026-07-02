import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Loading01Icon } from "@hugeicons/core-free-icons";

export interface ProgressInfo {
  phase: string;
  detail: string;
}

// Presentational only — App owns the message subscription and passes the latest
// progress down. This component adds two things the sandbox CAN'T provide:
//  - a spinner that keeps animating even while the sandbox is busy in a single
//    long await (loadAllPagesAsync, a network call) and sends no messages;
//  - an elapsed-time ticker driven by the UI clock, so the user always sees the
//    process is alive and how long it's been running.
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

  return (
    <>
      {scanning && (
        <div className="flex items-start gap-2.5 px-3.5 pb-2.5 pt-1">
          <HugeiconsIcon
            icon={Loading01Icon}
            size={16}
            className="mt-0.5 shrink-0 animate-spin text-primary"
          />
          <div className="min-w-0 flex-1">
            <div className="font-medium">
              {progress?.phase || "Starting…"}
              <span className="ml-2 font-normal text-muted-foreground">
                {elapsed}s
              </span>
            </div>
            {progress?.detail && (
              <div className="truncate text-muted-foreground">
                {progress.detail}
              </div>
            )}
          </div>
        </div>
      )}
      {warn && (
        <div className="px-3.5 py-1 text-muted-foreground">⚠ {warn}</div>
      )}
    </>
  );
}
