import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useGetMe } from "@workspace/api-client-react";
import { AppShell } from "@/components/app-shell";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

/** Mirrors CustomerImportRules on the server (lib/parsers/customerRules.ts). */
interface ImportRules {
  trustProvidedHours?: boolean;
  nameMode?: "combined" | "splitLastFirst";
  sheetSelector?: string;
  timeColumnMode?: "actual" | "scheduled";
  breakMinutes?: number;
  dropTotalRowPatterns?: string[];
  notes?: string;
}

interface CustomerRow {
  id: number;
  displayName: string;
  active: boolean;
  importRules: ImportRules | null;
}

const API = `${import.meta.env.BASE_URL}api`;

async function fetchCustomers(): Promise<CustomerRow[]> {
  const r = await fetch(`${API}/admin/customer-import-rules`, {
    credentials: "include",
  });
  if (!r.ok) throw new Error(`customers ${r.status}`);
  return r.json();
}

function ruleSummary(rules: ImportRules | null): string {
  if (!rules) return "Default";
  const bits: string[] = [];
  if (rules.sheetSelector) bits.push(`sheet: ${rules.sheetSelector}`);
  if (rules.nameMode === "splitLastFirst") bits.push("split name");
  if (rules.nameMode === "combined") bits.push("combined name");
  if (rules.timeColumnMode) bits.push(rules.timeColumnMode);
  if (rules.trustProvidedHours === false) bits.push("recompute hours");
  if (typeof rules.breakMinutes === "number")
    bits.push(`break ${rules.breakMinutes}m`);
  if (rules.dropTotalRowPatterns?.length)
    bits.push(`drop: ${rules.dropTotalRowPatterns.join("/")}`);
  return bits.length ? bits.join(" · ") : "Default";
}

function Editor({
  customer,
  onClose,
}: {
  customer: CustomerRow;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const r = customer.importRules ?? {};
  const [trustProvidedHours, setTrust] = useState<boolean>(
    r.trustProvidedHours !== false,
  );
  const [nameMode, setNameMode] = useState<string>(r.nameMode ?? "");
  const [sheetSelector, setSheet] = useState<string>(r.sheetSelector ?? "");
  const [timeColumnMode, setTimeMode] = useState<string>(r.timeColumnMode ?? "");
  const [breakMinutes, setBreak] = useState<string>(
    r.breakMinutes != null ? String(r.breakMinutes) : "",
  );
  const [dropPatterns, setDrop] = useState<string>(
    (r.dropTotalRowPatterns ?? []).join(", "),
  );
  const [notes, setNotes] = useState<string>(r.notes ?? "");

  const save = useMutation({
    mutationFn: async (importRules: ImportRules | null) => {
      const res = await fetch(
        `${API}/admin/customer-import-rules/${customer.id}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ importRules }),
        },
      );
      if (!res.ok) throw new Error(`save ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-import-rules"] });
      toast({ title: "Import rules saved" });
      onClose();
    },
    onError: () =>
      toast({ title: "Couldn't save rules", variant: "destructive" }),
  });

  function buildRules(): ImportRules {
    const out: ImportRules = {};
    // Only persist trust flag when it's the non-default (false); default
    // true is already the global behavior.
    if (!trustProvidedHours) out.trustProvidedHours = false;
    if (nameMode === "combined" || nameMode === "splitLastFirst")
      out.nameMode = nameMode;
    if (sheetSelector.trim()) out.sheetSelector = sheetSelector.trim();
    if (timeColumnMode === "actual" || timeColumnMode === "scheduled")
      out.timeColumnMode = timeColumnMode;
    const bm = Number(breakMinutes);
    if (breakMinutes.trim() && Number.isFinite(bm) && bm > 0)
      out.breakMinutes = Math.round(bm);
    const pats = dropPatterns
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (pats.length) out.dropTotalRowPatterns = pats;
    if (notes.trim()) out.notes = notes.trim();
    return out;
  }

  return (
    <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-border">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-semibold text-brand-navy">
          {customer.displayName}
        </h2>
        <button
          onClick={onClose}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          Close
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="flex items-start gap-2 sm:col-span-2">
          <input
            type="checkbox"
            checked={trustProvidedHours}
            onChange={(e) => setTrust(e.target.checked)}
            className="mt-1"
          />
          <span className="text-sm">
            <span className="font-medium">Trust the file's Total/Hours column</span>
            <span className="block text-xs text-muted-foreground">
              On (default): report the file's own hours, break &amp; rounding
              baked in. Off: recompute from clock in/out.
            </span>
          </span>
        </label>

        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-400">
            Name layout
          </div>
          <select
            value={nameMode}
            onChange={(e) => setNameMode(e.target.value)}
            className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm"
          >
            <option value="">Auto</option>
            <option value="combined">Combined (one cell)</option>
            <option value="splitLastFirst">Split Last / First</option>
          </select>
        </div>

        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-400">
            Times when both shown
          </div>
          <select
            value={timeColumnMode}
            onChange={(e) => setTimeMode(e.target.value)}
            className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm"
          >
            <option value="">Auto</option>
            <option value="actual">Use actual</option>
            <option value="scheduled">Use scheduled</option>
          </select>
        </div>

        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-400">
            Sheet to read (multi-sheet xlsx)
          </div>
          <Input
            value={sheetSelector}
            onChange={(e) => setSheet(e.target.value)}
            placeholder="e.g. Timecard, or 2"
          />
        </div>

        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-400">
            Fallback break minutes
          </div>
          <Input
            value={breakMinutes}
            onChange={(e) => setBreak(e.target.value)}
            placeholder="e.g. 30"
            inputMode="numeric"
          />
        </div>

        <div className="sm:col-span-2">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-400">
            Drop rows containing (comma-separated)
          </div>
          <Input
            value={dropPatterns}
            onChange={(e) => setDrop(e.target.value)}
            placeholder="grand total, subtotal, regular, overtime"
          />
        </div>

        <div className="sm:col-span-2">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-400">
            Notes
          </div>
          <Input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Why this rule exists"
          />
        </div>
      </div>

      <div className="mt-5 flex items-center gap-3">
        <Button
          disabled={save.isPending}
          onClick={() => {
            const rules = buildRules();
            save.mutate(Object.keys(rules).length ? rules : null);
          }}
        >
          Save
        </Button>
        <Button
          variant="outline"
          disabled={save.isPending}
          onClick={() => save.mutate(null)}
        >
          Clear to default
        </Button>
      </div>
    </div>
  );
}

export default function AdminImportRules() {
  const { data: me, isLoading: meLoading } = useGetMe();
  const [, setLocation] = useLocation();
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);

  useEffect(() => {
    if (!meLoading && me && !me.isAdmin) setLocation("/");
  }, [meLoading, me, setLocation]);

  const { data: customers = [], isLoading } = useQuery({
    queryKey: ["admin-import-rules"],
    queryFn: fetchCustomers,
  });

  const needle = q.trim().toLowerCase();
  const rows = useMemo(
    () =>
      customers.filter(
        (c) => !needle || c.displayName.toLowerCase().includes(needle),
      ),
    [customers, needle],
  );
  const open = customers.find((c) => c.id === openId) ?? null;

  return (
    <AppShell active="/settings">
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-semibold text-brand-navy">Import rules</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Per-customer exceptions for how their timesheet is read — which
            sheet, how names are laid out, scheduled vs. actual times, and
            summary rows to drop. Blank = default (which already honors each
            file's own Total/Hours column).
          </p>
        </div>

        {open ? (
          <Editor customer={open} onClose={() => setOpenId(null)} />
        ) : (
          <>
            <Input
              placeholder="Search customer…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="max-w-sm"
            />
            <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-border">
              {isLoading ? (
                <div className="p-5 text-sm text-muted-foreground">Loading…</div>
              ) : rows.length === 0 ? (
                <div className="p-5 text-sm text-muted-foreground">
                  No customers.
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {rows.map((c) => (
                    <li
                      key={c.id}
                      className={cn(
                        "flex items-center gap-4 px-4 py-2.5",
                        !c.active && "bg-muted/40",
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-foreground">
                          {c.displayName}
                          {!c.active && (
                            <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground ring-1 ring-border">
                              Inactive
                            </span>
                          )}
                        </div>
                        <div
                          className={cn(
                            "truncate text-xs",
                            c.importRules
                              ? "text-brand-navy"
                              : "text-muted-foreground",
                          )}
                        >
                          {ruleSummary(c.importRules)}
                        </div>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setOpenId(c.id)}
                      >
                        Edit
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}
