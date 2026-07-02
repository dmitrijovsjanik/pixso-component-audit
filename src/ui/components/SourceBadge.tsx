import { Badge } from "./ui/badge";
import { sourceLabel } from "@/lib/audit";
import type { Origin } from "@/lib/types";

export function SourceBadge({
  origin,
  library,
}: {
  origin: Origin;
  library?: string | null;
}) {
  const variant =
    origin === "library" ? "library" : origin === "local" ? "local" : "unknown";
  return <Badge variant={variant}>{sourceLabel({ origin, library })}</Badge>;
}
