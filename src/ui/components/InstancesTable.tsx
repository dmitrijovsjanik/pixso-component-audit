import { useMemo, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  ArrowUpDownIcon,
  ArrowRight01Icon,
  EyeOffIcon,
  CircleLock01Icon,
} from "@hugeicons/core-free-icons";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table";
import { Badge } from "./ui/badge";
import { SourceBadge } from "./SourceBadge";
import { cn } from "@/lib/utils";
import {
  buildTree,
  groupInstances,
  sortGroups,
  visibleInstances,
  type Filters,
  type TreeNode,
} from "@/lib/audit";
import type {
  InstanceRecord,
  ScanResult,
  SortDir,
  SortKey,
  ViewMode,
} from "@/lib/types";

interface Props {
  result: ScanResult;
  filters: Filters;
  viewMode: ViewMode;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
  selectedId: string | null;
  notFoundId: string | null;
  onFocus: (nodeId: string) => void;
}

function SortArrow({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active)
    return (
      <HugeiconsIcon
        icon={ArrowUpDownIcon}
        size={11}
        className="ml-0.5 inline opacity-30"
      />
    );
  return (
    <HugeiconsIcon
      icon={dir > 0 ? ArrowUp01Icon : ArrowDown01Icon}
      size={11}
      className="ml-0.5 inline text-primary"
    />
  );
}

function HiddenMark() {
  return (
    <HugeiconsIcon
      icon={EyeOffIcon}
      size={11}
      className="inline opacity-50"
      aria-label="hidden"
    />
  );
}

// The clickable row surface — highlighting for selected / not-found (deleted).
function rowClasses(
  focusable: boolean,
  selected: boolean,
  notFound: boolean
): string {
  return cn(
    focusable && "cursor-pointer hover:bg-accent",
    selected && "bg-primary/15 hover:bg-primary/15",
    notFound && "!bg-destructive/20"
  );
}

export function InstancesTable(props: Props) {
  const { viewMode } = props;

  return (
    <div className="mx-3.5 mb-2.5 max-h-[340px] overflow-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow className="border-b">
            <Th
              label="Component / variant / instance"
              k="name"
              {...props}
              width="w-[46%]"
            />
            <Th label="Source" k="source" {...props} width="w-[26%]" />
            <Th label="Count" k="count" {...props} width="w-[12%]" />
            <TableHead className="w-[16%]">Page</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {viewMode === "tree" ? (
            <TreeRows {...props} />
          ) : (
            <FlatRows {...props} />
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function Th({
  label,
  k,
  sortKey,
  sortDir,
  onSort,
  width,
}: Props & { label: string; k: SortKey; width: string }) {
  return (
    <TableHead
      className={cn(width, "cursor-pointer select-none hover:bg-accent")}
      onClick={() => onSort(k)}
    >
      {label}
      <SortArrow active={sortKey === k} dir={sortDir} />
    </TableHead>
  );
}

function EmptyRow({ text }: { text: string }) {
  return (
    <TableRow className="border-0 hover:bg-transparent">
      <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
        {text}
      </TableCell>
    </TableRow>
  );
}

// ---------------- FLAT VIEW ----------------

function FlatRows(props: Props) {
  const { result, filters, sortKey, sortDir } = props;
  const groups = useMemo(() => {
    const rows = visibleInstances(result, filters);
    return sortGroups(groupInstances(rows), sortKey, sortDir);
  }, [result, filters, sortKey, sortDir]);

  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (id: string) =>
    setOpen((o) => ({ ...o, [id]: !o[id] }));

  if (!groups.length) return <EmptyRow text="No instances found." />;

  const rows: React.ReactNode[] = [];

  groups.forEach((g, gi) => {
    const gid = "g" + gi;
    const hasVariants = !(
      g.variantOrder.length === 1 && g.variantOrder[0] === "(no variants)"
    );

    // Single instance, no variants -> one clickable leaf row.
    if (g.count === 1 && !hasVariants) {
      const only = g.variants[g.variantOrder[0]].items[0];
      rows.push(
        <LeafRow
          key={gid}
          rec={only}
          label={g.name}
          bold
          badgeMaster={g.hasMaster}
          source={<SourceBadge origin={g.origin} library={g.library} />}
          count={<b>1</b>}
          {...props}
        />
      );
      return;
    }

    const gOpen = !!open[gid];
    rows.push(
      <GroupRow
        key={gid}
        open={gOpen}
        onToggle={() => toggle(gid)}
        name={g.name}
        badgeMaster={g.hasMaster}
        source={<SourceBadge origin={g.origin} library={g.library} />}
        count={g.count}
        depth={0}
      />
    );

    if (!gOpen) return;

    g.variantOrder.forEach((vk, vi) => {
      const v = g.variants[vk];
      const vid = gid + "v" + vi;
      const vOpen = !!open[vid];
      if (hasVariants) {
        rows.push(
          <GroupRow
            key={vid}
            open={vOpen}
            onToggle={() => toggle(vid)}
            name={v.name}
            count={v.count}
            depth={1}
            muted
          />
        );
        if (!vOpen) return;
      }
      v.items.forEach((r, ri) => {
        rows.push(
          <LeafRow
            key={vid + "i" + ri}
            rec={r}
            label={r.path.split(" / ").slice(-1)[0] || r.componentName}
            depth={hasVariants ? 2 : 1}
            badgeMaster={r.isMaster}
            {...props}
          />
        );
      });
    });
  });

  return <>{rows}</>;
}

function indent(depth: number) {
  return { paddingLeft: 8 + depth * 18 };
}

function GroupRow({
  open,
  onToggle,
  name,
  badgeMaster,
  source,
  count,
  depth,
  muted,
}: {
  open: boolean;
  onToggle: () => void;
  name: string;
  badgeMaster?: boolean;
  source?: React.ReactNode;
  count: number;
  depth: number;
  muted?: boolean;
}) {
  return (
    <TableRow
      className="cursor-pointer bg-muted/40 hover:bg-muted"
      onClick={onToggle}
    >
      <TableCell>
        <span style={indent(depth)} className="flex items-center gap-1">
          <HugeiconsIcon
            icon={open ? ArrowDown01Icon : ArrowRight01Icon}
            size={12}
            className="shrink-0 opacity-60"
          />
          <span className={cn("truncate", muted ? "" : "font-semibold")}>
            {name}
          </span>
          {badgeMaster && <Badge variant="master">master</Badge>}
        </span>
      </TableCell>
      <TableCell>{source}</TableCell>
      <TableCell className="font-semibold">{count}</TableCell>
      <TableCell />
    </TableRow>
  );
}

function LeafRow({
  rec,
  label,
  bold,
  depth = 0,
  badgeMaster,
  source,
  count,
  selectedId,
  notFoundId,
  onFocus,
}: Props & {
  rec: InstanceRecord;
  label: string;
  bold?: boolean;
  depth?: number;
  badgeMaster?: boolean;
  source?: React.ReactNode;
  count?: React.ReactNode;
}) {
  const selected = selectedId === rec.nodeId;
  const notFound = notFoundId === rec.nodeId;
  return (
    <TableRow
      className={rowClasses(true, selected, notFound)}
      title="Click to focus on canvas"
      onClick={() => onFocus(rec.nodeId)}
    >
      <TableCell>
        <span style={indent(depth)} className="flex items-center gap-1">
          {!rec.visible && <HiddenMark />}
          {badgeMaster && <Badge variant="master">master</Badge>}
          {rec.inSlot && (
            <HugeiconsIcon
              icon={CircleLock01Icon}
              size={11}
              className="opacity-50"
            />
          )}
          <span className={cn("truncate", bold && "font-semibold")}>
            {label}
          </span>
        </span>
      </TableCell>
      <TableCell>{source}</TableCell>
      <TableCell>{count}</TableCell>
      <TableCell className="text-muted-foreground">{rec.page}</TableCell>
    </TableRow>
  );
}

// ---------------- TREE VIEW ----------------

function TreeRows(props: Props) {
  const { result, filters } = props;
  const roots = useMemo(
    () => buildTree(result, filters),
    [result, filters]
  );
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (id: string) => setOpen((o) => ({ ...o, [id]: !o[id] }));

  if (!roots.length) return <EmptyRow text="No instances found." />;

  const rows: React.ReactNode[] = [];
  const walk = (node: TreeNode, depth: number) => {
    const { rec, children } = node;
    const hasKids = children.length > 0;
    const isOpen = !!open[rec.nodeId];
    const selected = props.selectedId === rec.nodeId;
    const notFound = props.notFoundId === rec.nodeId;
    rows.push(
      <TableRow
        key={rec.nodeId}
        className={rowClasses(true, selected, notFound)}
        title="Click to focus on canvas"
        onClick={() => props.onFocus(rec.nodeId)}
      >
        <TableCell>
          <span style={indent(depth)} className="flex items-center gap-1">
            {hasKids ? (
              <button
                className="flex shrink-0 items-center"
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(rec.nodeId);
                }}
              >
                <HugeiconsIcon
                  icon={isOpen ? ArrowDown01Icon : ArrowRight01Icon}
                  size={12}
                  className="opacity-60"
                />
              </button>
            ) : (
              <span className="w-3 shrink-0" />
            )}
            {rec.isMaster && <Badge variant="master">master</Badge>}
            {!rec.visible && <HiddenMark />}
            <span className="truncate font-semibold">{rec.componentName}</span>
            {rec.variant && (
              <span className="truncate text-muted-foreground">
                · {rec.variant}
              </span>
            )}
            {hasKids && (
              <span className="text-muted-foreground">({children.length})</span>
            )}
          </span>
        </TableCell>
        <TableCell>
          <SourceBadge origin={rec.origin} library={rec.libraryName} />
        </TableCell>
        <TableCell />
        <TableCell className="text-muted-foreground">{rec.page}</TableCell>
      </TableRow>
    );
    if (isOpen) children.forEach((c) => walk(c, depth + 1));
  };
  roots.forEach((r) => walk(r, 0));
  return <>{rows}</>;
}
