import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { formatPersonName } from "@/lib/format-name";

export interface DriverOption {
  kfiId: string;
  name: string;
  customer: string;
}

/**
 * Searchable, scroll-safe driver picker for the import review.
 *
 * Replaces the bare full-roster <Select> (no search) that made mapping an
 * unmatched driver slow. Uses an in-flow (non-portaled) cmdk Command so it
 * scrolls inside the modal Dialog — a portaled Popover/Select can't, because
 * the Dialog's scroll-lock swallows wheel events (same pattern as the manual
 * punch customer picker in driver-detail).
 *
 * `value` is a kfiId, or one of the sentinel `skipValue` / `ignoreValue`.
 */
export function DriverPicker({
  value,
  onChange,
  drivers,
  suggestedKfiId,
  skipValue,
  ignoreValue,
  labels,
  testId,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Pre-ordered: suggested drivers first, then the rest of the roster. */
  drivers: DriverOption[];
  suggestedKfiId?: string;
  skipValue: string;
  ignoreValue: string;
  labels: {
    skip: string;
    ignore: string;
    placeholder: string;
    search: string;
    noResults: string;
    suggested: string;
  };
  testId?: string;
}) {
  const [open, setOpen] = useState(false);

  const selectedLabel = (() => {
    if (value === skipValue) return labels.skip;
    if (value === ignoreValue) return labels.ignore;
    const d = drivers.find((x) => x.kfiId === value);
    if (d) return formatPersonName(d.name);
    return labels.placeholder;
  })();

  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
  };

  return (
    <div>
      <Button
        type="button"
        variant="outline"
        role="combobox"
        aria-expanded={open}
        className={cn(
          "h-9 w-full justify-between font-normal",
          value === "" && "text-muted-foreground",
        )}
        data-testid={testId}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="truncate">{selectedLabel}</span>
        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
      </Button>
      {open && (
        <Command className="mt-1 rounded-md border">
          <CommandInput autoFocus placeholder={labels.search} />
          <CommandList className="max-h-[240px]">
            <CommandEmpty>{labels.noResults}</CommandEmpty>
            <CommandGroup>
              <CommandItem value={`__skip ${labels.skip}`} onSelect={() => pick(skipValue)}>
                <Check
                  className={cn(
                    "mr-2 h-4 w-4",
                    value === skipValue ? "opacity-100" : "opacity-0",
                  )}
                />
                {labels.skip}
              </CommandItem>
              <CommandItem value={`__ignore ${labels.ignore}`} onSelect={() => pick(ignoreValue)}>
                <Check
                  className={cn(
                    "mr-2 h-4 w-4",
                    value === ignoreValue ? "opacity-100" : "opacity-0",
                  )}
                />
                {labels.ignore}
              </CommandItem>
            </CommandGroup>
            <CommandGroup>
              {drivers.map((d) => (
                <CommandItem
                  // Include name + id so search matches either; onSelect uses
                  // the closure kfiId (cmdk may normalize the passed value).
                  key={d.kfiId}
                  value={`${d.name} ${d.kfiId}`}
                  onSelect={() => pick(d.kfiId)}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      value === d.kfiId ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="font-medium">{formatPersonName(d.name)}</span>
                  <span className="ml-2 fin-num text-[10px] text-muted-foreground">
                    {d.kfiId} · {d.customer}
                  </span>
                  {d.kfiId === suggestedKfiId ? (
                    <span className="ml-2 text-[10px] text-emerald-600 dark:text-emerald-400">
                      {labels.suggested}
                    </span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      )}
    </div>
  );
}
