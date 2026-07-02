import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { Checkbox } from "./ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { cn } from "@/lib/utils";

interface Props {
  libraries: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}

// Multi-select for the library filter. Empty selection = all libraries.
export function LibraryMultiSelect({ libraries, selected, onChange }: Props) {
  const toggle = (name: string) => {
    onChange(
      selected.indexOf(name) === -1
        ? [...selected, name]
        : selected.filter((n) => n !== name)
    );
  };

  const label =
    selected.length === 0
      ? "All libraries"
      : selected.length === 1
        ? selected[0]
        : `${selected.length} libraries`;

  const disabled = libraries.length === 0;

  return (
    <Popover>
      <PopoverTrigger
        disabled={disabled}
        className={cn(
          "flex h-8 w-[150px] items-center justify-between gap-1 rounded-md border bg-background px-2.5 py-1 text-xs shadow-sm transition-colors focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer",
          selected.length === 0 && "text-muted-foreground"
        )}
        title={selected.length > 1 ? selected.join(", ") : undefined}
      >
        <span className="truncate">{label}</span>
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          size={14}
          className="shrink-0 opacity-60"
        />
      </PopoverTrigger>
      <PopoverContent className="max-h-72 w-[220px] overflow-auto">
        {selected.length > 0 && (
          <button
            className="mb-1 w-full rounded-sm px-2 py-1 text-left text-[11px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            onClick={() => onChange([])}
          >
            Clear ({selected.length})
          </button>
        )}
        {libraries.map((name) => {
          const checked = selected.indexOf(name) !== -1;
          return (
            <label
              key={name}
              className="flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent"
            >
              <Checkbox
                checked={checked}
                onCheckedChange={() => toggle(name)}
              />
              <span className="truncate" title={name}>
                {name}
              </span>
            </label>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
