import { HugeiconsIcon } from "@hugeicons/react";
import { Search01Icon } from "@hugeicons/core-free-icons";
import { Input } from "./ui/input";
import { Checkbox } from "./ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import type { Filters } from "@/lib/audit";
import type { ViewMode } from "@/lib/types";

interface Props {
  filters: Filters;
  setFilters: (patch: Partial<Filters>) => void;
  libraries: string[];
  viewMode: ViewMode;
  setViewMode: (v: ViewMode) => void;
  shown: number;
  total: number;
}

// Radix Select uses "" as a reserved empty; use a sentinel for "all".
const ALL = "__all__";

export function FilterBar({
  filters,
  setFilters,
  libraries,
  viewMode,
  setViewMode,
  shown,
  total,
}: Props) {
  return (
    <div className="flex flex-wrap items-center gap-2 px-3.5 py-2">
      <div className="relative min-w-[160px] flex-1">
        <HugeiconsIcon
          icon={Search01Icon}
          size={13}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          className="pl-7"
          placeholder="Search component name…"
          value={filters.search}
          onChange={(e) => setFilters({ search: e.target.value })}
        />
      </div>

      <Select
        value={filters.origin || ALL}
        onValueChange={(v) => setFilters({ origin: v === ALL ? "" : v })}
      >
        <SelectTrigger className="w-[120px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All origins</SelectItem>
          <SelectItem value="library">Library</SelectItem>
          <SelectItem value="local">Local</SelectItem>
          <SelectItem value="unknown">Unresolved</SelectItem>
        </SelectContent>
      </Select>

      <Select
        value={filters.library || ALL}
        onValueChange={(v) => setFilters({ library: v === ALL ? "" : v })}
      >
        <SelectTrigger className="w-[150px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All libraries</SelectItem>
          {libraries.map((n) => (
            <SelectItem key={n} value={n}>
              {n}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={viewMode}
        onValueChange={(v) => setViewMode(v as ViewMode)}
      >
        <SelectTrigger className="w-[130px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="flat">Flat (by name)</SelectItem>
          <SelectItem value="tree">Tree (nesting)</SelectItem>
        </SelectContent>
      </Select>

      <label className="flex cursor-pointer select-none items-center gap-1.5 text-[11px]">
        <Checkbox
          checked={filters.showNested}
          disabled={viewMode === "tree"}
          onCheckedChange={(c) => setFilters({ showNested: !!c })}
        />
        Nested
      </label>
      <label className="flex cursor-pointer select-none items-center gap-1.5 text-[11px]">
        <Checkbox
          checked={filters.showHidden}
          onCheckedChange={(c) => setFilters({ showHidden: !!c })}
        />
        Hidden
      </label>

      <span className="ml-auto whitespace-nowrap text-[11px] text-muted-foreground">
        {shown === total ? `${total} instances` : `${shown} of ${total}`}
      </span>
    </div>
  );
}
