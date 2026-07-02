import { useCallback, useEffect, useState } from "react";
import { Progress } from "./ui/progress";
import { useSandboxMessages } from "@/lib/messaging";
import type { IncomingMsg } from "@/lib/types";

interface ProgressState {
  active: boolean;
  pct: number;
  phase: string;
  detail: string;
}

const IDLE: ProgressState = { active: false, pct: 0, phase: "", detail: "" };

// Owns its own progress state and subscribes to progress/warn messages directly.
// Progress ticks fire hundreds of times per scan; keeping them here means each
// tick re-renders only this small component, not the whole App (which holds the
// heavy tables). `active` is driven by the `scanning` prop (scan start/end) and
// by result/error messages that end a scan.
export function ScanProgress({ scanning }: { scanning: boolean }) {
  const [state, setState] = useState<ProgressState>(IDLE);
  const [warn, setWarn] = useState<string | null>(null);

  const onMessage = useCallback((msg: IncomingMsg) => {
    if (msg.type === "progress") {
      const pct = msg.total ? Math.round((msg.done / msg.total) * 100) : 0;
      setState({
        active: true,
        pct,
        phase: `${msg.phase}  —  ${pct}%`,
        detail: msg.detail || `${msg.done} / ${msg.total}`,
      });
    } else if (msg.type === "warn") {
      setWarn(msg.message);
    } else if (msg.type === "result" || msg.type === "error") {
      setState((s) => ({ ...s, active: false }));
    }
  }, []);

  useSandboxMessages(onMessage);

  // A fresh scan clears the last run's warning and resets the bar.
  useEffect(() => {
    if (scanning) {
      setWarn(null);
      setState({ active: true, pct: 0, phase: "Starting…", detail: "" });
    }
  }, [scanning]);

  const showActive = scanning || state.active;

  return (
    <>
      {showActive && (
        <div className="px-3.5 pb-2.5">
          <Progress value={state.pct} />
          <div className="mt-1 text-muted-foreground">
            {state.phase || "Starting…"}
          </div>
          {state.detail && (
            <div className="text-muted-foreground">{state.detail}</div>
          )}
        </div>
      )}
      {warn && (
        <div className="px-3.5 py-1 text-muted-foreground">⚠ {warn}</div>
      )}
    </>
  );
}
