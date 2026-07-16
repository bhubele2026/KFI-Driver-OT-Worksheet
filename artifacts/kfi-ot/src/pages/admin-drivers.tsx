import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useGetMe } from "@workspace/api-client-react";
import { useEffect } from "react";
import { AppShell } from "@/components/app-shell";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

interface DriverRow {
  kfiId: string;
  name: string;
  customer: string;
  deactivated: boolean;
  isArchived: boolean;
}

const API = `${import.meta.env.BASE_URL}api`;

async function fetchDrivers(): Promise<DriverRow[]> {
  const r = await fetch(`${API}/admin/drivers`, { credentials: "include" });
  if (!r.ok) throw new Error(`drivers ${r.status}`);
  return r.json();
}

export default function AdminDrivers() {
  const { data: me, isLoading: meLoading } = useGetMe();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [q, setQ] = useState("");

  useEffect(() => {
    if (!meLoading && me && !me.isAdmin) setLocation("/");
  }, [meLoading, me, setLocation]);

  const { data: drivers = [], isLoading } = useQuery({
    queryKey: ["admin-drivers"],
    queryFn: fetchDrivers,
  });

  const toggle = useMutation({
    mutationFn: async (v: { kfiId: string; deactivated: boolean }) => {
      const r = await fetch(`${API}/drivers/${v.kfiId}/deactivated`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ deactivated: v.deactivated }),
      });
      if (!r.ok) throw new Error(`toggle ${r.status}`);
      return r.json();
    },
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ["admin-drivers"] });
      toast({
        title: v.deactivated ? "Driver deactivated" : "Driver reactivated",
        description: v.deactivated
          ? "Their Connecteam time will stop importing on the next refresh."
          : "They're active again.",
      });
    },
    onError: () =>
      toast({ title: "Couldn't update driver", variant: "destructive" }),
  });

  const needle = q.trim().toLowerCase();
  const rows = drivers
    .filter(
      (d) =>
        !needle ||
        d.name.toLowerCase().includes(needle) ||
        d.kfiId.toLowerCase().includes(needle) ||
        d.customer.toLowerCase().includes(needle),
    )
    .sort((a, b) => Number(a.deactivated) - Number(b.deactivated) || a.name.localeCompare(b.name));

  return (
    <AppShell active="/settings">
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-semibold text-brand-navy">Drivers</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Turn someone off when they're no longer a driver — their Connecteam time stops
            importing and they drop off the roster. Turn them back on here anytime.
          </p>
        </div>

        <Input
          placeholder="Search name, KFI ID, or customer…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="max-w-sm"
        />

        <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-border">
          {isLoading ? (
            <div className="p-5 text-sm text-muted-foreground">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="p-5 text-sm text-muted-foreground">No drivers.</div>
          ) : (
            <ul className="divide-y divide-border">
              {rows.map((d) => (
                <li
                  key={d.kfiId}
                  className={cn(
                    "flex items-center gap-4 px-4 py-2.5",
                    d.deactivated && "bg-muted/40",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div
                      className={cn(
                        "truncate text-sm font-medium",
                        d.deactivated ? "text-muted-foreground" : "text-foreground",
                      )}
                    >
                      {d.name}
                      {d.deactivated && (
                        <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground ring-1 ring-border">
                          Not a driver
                        </span>
                      )}
                    </div>
                    <div className="fin-num text-xs text-muted-foreground">
                      {d.kfiId} · {d.customer}
                    </div>
                  </div>
                  <Button
                    variant={d.deactivated ? "default" : "outline"}
                    size="sm"
                    disabled={toggle.isPending}
                    onClick={() =>
                      toggle.mutate({ kfiId: d.kfiId, deactivated: !d.deactivated })
                    }
                  >
                    {d.deactivated ? "Reactivate" : "Mark not a driver"}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </AppShell>
  );
}
