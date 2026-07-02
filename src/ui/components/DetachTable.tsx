import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table";
import { cn } from "@/lib/utils";
import type { DetachRecord } from "@/lib/types";

export function DetachTable({
  rows,
  selectedId,
  notFoundId,
  onFocus,
}: {
  rows: DetachRecord[];
  selectedId: string | null;
  notFoundId: string | null;
  onFocus: (nodeId: string) => void;
}) {
  return (
    <div className="mx-3.5 mb-2.5 max-h-[340px] overflow-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow className="border-b">
            <TableHead className="w-[26%]">Layer</TableHead>
            <TableHead className="w-[26%]">Matched component</TableHead>
            <TableHead className="w-[18%]">Page</TableHead>
            <TableHead className="w-[30%]">Path</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {!rows.length ? (
            <TableRow className="border-0 hover:bg-transparent">
              <TableCell
                colSpan={4}
                className="py-6 text-center text-muted-foreground"
              >
                No name-matched detached layers.
              </TableCell>
            </TableRow>
          ) : (
            rows.map((r) => {
              const selected = selectedId === r.nodeId;
              const notFound = notFoundId === r.nodeId;
              return (
                <TableRow
                  key={r.nodeId}
                  className={cn(
                    "cursor-pointer hover:bg-accent",
                    selected && "bg-primary/15 hover:bg-primary/15",
                    notFound && "!bg-destructive/20"
                  )}
                  title="Click to focus on canvas"
                  onClick={() => onFocus(r.nodeId)}
                >
                  <TableCell>{r.layerName}</TableCell>
                  <TableCell>{r.matchedComponentName}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {r.page}
                  </TableCell>
                  <TableCell
                    className="text-muted-foreground"
                    title={r.path}
                  >
                    {r.path}
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}
