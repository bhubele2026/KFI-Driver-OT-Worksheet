import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { useAccess, invalidateAccess } from "@/lib/access";

interface RegistryTile {
  key: string;
  group: string;
  title: string;
  ownerOnly: boolean;
  adminOnly: boolean;
}
interface AccessUser {
  id: number;
  email: string;
  isAdmin: boolean;
  isActive: boolean;
  role: string;
  lastLoginAt: string | null;
  tiles: string[];
}
interface AccessPayload {
  registry: RegistryTile[];
  groups: string[];
  users: AccessUser[];
}
interface Activity {
  days: number;
  byUser: Array<{ email: string; total: number; last_active: string }>;
  byTile: Array<{ tile: string; total: number; users: number }>;
  recent: Array<{ email: string; tile: string; kind: string; detail: string | null; opened_at: string }>;
}

const api = (p: string) => `${import.meta.env.BASE_URL}api${p}`;
const firstName = (email: string) => email.split("@")[0].replace(/[._]/g, " ");
const when = (v: string | null) => (v ? new Date(v).toLocaleString() : "never");

export default function AdminAccess() {
  const [, setLocation] = useLocation();
  const access = useAccess();
  const [tab, setTab] = useState<"access" | "activity">("access");
  const [data, setData] = useState<AccessPayload | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [draft, setDraft] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [days, setDays] = useState(30);

  // Owner-only surface. The server enforces it too; this is just the UI.
  useEffect(() => {
    if (access && !access.isOwner) setLocation("/");
  }, [access, setLocation]);

  const load = () =>
    fetch(api("/admin/tile-access"), { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: AccessPayload) => setData(d))
      .catch(() => setData(null));

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (tab !== "activity") return;
    void fetch(api(`/admin/tile-activity?days=${days}`), { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: Activity) => setActivity(d))
      .catch(() => setActivity(null));
  }, [tab, days]);

  const current = useMemo(
    () => data?.users.find((u) => u.id === selected) ?? null,
    [data, selected],
  );
  const saved = current?.tiles ?? [];
  const dirty = useMemo(() => {
    const a = [...saved].sort().join("|");
    const b = [...draft].sort().join("|");
    return a !== b;
  }, [saved, draft]);

  const pick = (u: AccessUser) => {
    if (dirty && !confirm("You have unsaved tile changes. Discard them?")) return;
    setSelected(u.id);
    setDraft(u.tiles);
  };

  const toggle = (key: string) =>
    setDraft((d) => (d.includes(key) ? d.filter((k) => k !== key) : [...d, key]));

  const save = async () => {
    if (!current) return;
    setSaving(true);
    try {
      const r = await fetch(api("/admin/user-tiles"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: current.id, tiles: draft }),
      });
      if (r.ok) {
        // Reconcile from what actually persisted, not from the draft.
        const { tiles } = (await r.json()) as { tiles: string[] };
        setDraft(tiles);
        await load();
        invalidateAccess();
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppShell active="/settings">
      <div className="rise-in space-y-5">
        <div>
          <h1 className="text-xl font-semibold text-brand-navy">Access &amp; activity</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Who can see which tiles, and what people have been opening.
          </p>
        </div>

        <div className="flex gap-1">
          {(["access", "activity"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={
                tab === k
                  ? "rounded-md bg-brand-navy px-3 py-1.5 text-sm font-medium text-white"
                  : "rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted"
              }
            >
              {k === "access" ? "Access" : "Activity"}
            </button>
          ))}
        </div>

        {tab === "access" ? (
          <div className="grid gap-5 lg:grid-cols-[22rem_minmax(0,1fr)]">
            {/* People */}
            <div className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-border">
              <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
                People
              </div>
              <div className="space-y-1">
                {(data?.users ?? []).map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => pick(u)}
                    className={
                      "flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-sm transition-colors " +
                      (selected === u.id ? "bg-brand-navy/10" : "hover:bg-muted")
                    }
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-brand-navy">{u.email}</span>
                      <span className="block text-xs text-muted-foreground">
                        {u.isAdmin ? "admin" : u.role}
                        {u.isActive ? "" : " · inactive"}
                      </span>
                    </span>
                    <span className="fin-num ml-2 shrink-0 text-xs text-neutral-400">
                      {u.tiles.length}
                    </span>
                  </button>
                ))}
                {!data && <p className="text-sm text-muted-foreground">Loading…</p>}
              </div>
            </div>

            {/* Their tiles */}
            <div className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-border">
              {!current ? (
                <p className="text-sm text-muted-foreground">
                  Pick a person to set which tiles they see.
                </p>
              ) : (
                <>
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <div>
                      <div className="font-semibold text-brand-navy">{current.email}</div>
                      <div className="text-xs text-muted-foreground">
                        last signed in {when(current.lastLoginAt)}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {dirty && (
                        <span className="fin-num text-xs text-brand-orange">unsaved</span>
                      )}
                      <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>
                        {saving ? "Saving…" : "Save changes"}
                      </Button>
                    </div>
                  </div>

                  {/* Grouped checkboxes, deliberately NOT a matrix: the Dashboard
                      shipped a 20-column grid and you could not tell whose access
                      you were changing. */}
                  <div className="grid gap-5 sm:grid-cols-2">
                    {(data?.groups ?? []).map((g) => {
                      const inGroup = (data?.registry ?? []).filter((t) => t.group === g);
                      if (!inGroup.length) return null;
                      return (
                        <div key={g}>
                          <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
                            {g}
                          </div>
                          <div className="space-y-1.5">
                            {inGroup.map((t) => (
                              <label
                                key={t.key}
                                className={
                                  "flex items-start gap-2 text-sm " +
                                  (t.ownerOnly ? "opacity-50" : "cursor-pointer")
                                }
                              >
                                <input
                                  type="checkbox"
                                  className="mt-0.5"
                                  disabled={t.ownerOnly}
                                  checked={!t.ownerOnly && draft.includes(t.key)}
                                  onChange={() => toggle(t.key)}
                                />
                                <span>
                                  <span className="text-brand-navy">{t.title}</span>
                                  {t.ownerOnly && (
                                    <span className="block text-xs text-muted-foreground">
                                      Owner only — never grantable
                                    </span>
                                  )}
                                  {!t.ownerOnly && t.adminOnly && !current.isAdmin && (
                                    <span className="block text-xs text-muted-foreground">
                                      Also needs admin
                                    </span>
                                  )}
                                </span>
                              </label>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            <div className="flex gap-1">
              {[7, 30, 90].map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDays(d)}
                  className={
                    days === d
                      ? "fin-num rounded-md bg-brand-navy px-2.5 py-1 text-xs text-white"
                      : "fin-num rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted"
                  }
                >
                  {d}d
                </button>
              ))}
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              <div className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-border">
                <div className="mb-3 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
                  Most-used tiles
                </div>
                {(activity?.byTile ?? []).map((t) => (
                  <div key={t.tile} className="mb-2">
                    <div className="flex justify-between text-sm">
                      <span className="text-brand-navy">{t.tile}</span>
                      <span className="fin-num text-muted-foreground">
                        {t.total} · {t.users} {t.users === 1 ? "person" : "people"}
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 rounded bg-muted">
                      <div
                        className="h-1.5 rounded bg-brand-navy"
                        style={{
                          width: `${Math.round(
                            (t.total / Math.max(1, activity?.byTile?.[0]?.total ?? 1)) * 100,
                          )}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
                {!activity?.byTile?.length && (
                  <p className="text-sm text-muted-foreground">Nothing opened in this window.</p>
                )}
              </div>

              <div className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-border">
                <div className="mb-3 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
                  By person
                </div>
                {(activity?.byUser ?? []).map((u) => (
                  <div key={u.email} className="mb-2 flex justify-between text-sm">
                    <span className="text-brand-navy">{firstName(u.email)}</span>
                    <span className="fin-num text-muted-foreground">
                      {u.total} · {when(u.last_active)}
                    </span>
                  </div>
                ))}
                {!activity?.byUser?.length && (
                  <p className="text-sm text-muted-foreground">No activity yet.</p>
                )}
              </div>
            </div>

            <div className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-border">
              <div className="mb-3 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
                Recent
              </div>
              <div className="max-h-80 space-y-1 overflow-y-auto">
                {(activity?.recent ?? []).map((e, i) => (
                  <div key={i} className="flex gap-3 text-sm">
                    <span className="fin-num w-36 shrink-0 text-muted-foreground">
                      {new Date(e.opened_at).toLocaleString()}
                    </span>
                    <span className="text-brand-navy">{firstName(e.email ?? "")}</span>
                    <span className="text-muted-foreground">
                      {e.kind === "login" ? "signed in" : `opened ${e.tile}`}
                    </span>
                  </div>
                ))}
                {!activity?.recent?.length && (
                  <p className="text-sm text-muted-foreground">Nothing yet.</p>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
