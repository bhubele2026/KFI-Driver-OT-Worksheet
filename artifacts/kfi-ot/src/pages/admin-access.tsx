import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { useAccess, invalidateAccess } from "@/lib/access";

interface RegistryTile {
  key: string;
  group: string;
  title: string;
  blurb: string;
  ownerOnly: boolean;
  adminOnly: boolean;
  /** A grant that confers other tiles rather than opening a page of its own. */
  isGroupGrant: boolean;
  /** The tile keys this grant confers. Empty for ordinary tiles. */
  covers: string[];
}
interface AccessUser {
  id: number;
  email: string;
  isAdmin: boolean;
  isActive: boolean;
  role: string;
  lastLoginAt: string | null;
  tiles: string[];
  /** Holds every tile implicitly, so carries no grant rows. */
  isOwner: boolean;
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

  /** How many grants differ from what is stored — added and removed both count. */
  const changeCount = useMemo(() => {
    const before = new Set(saved);
    const after = new Set(draft);
    let n = 0;
    for (const k of after) if (!before.has(k)) n++;
    for (const k of before) if (!after.has(k)) n++;
    return n;
  }, [saved, draft]);

  const pick = (u: AccessUser) => {
    if (dirty && !confirm("You have unsaved tile changes. Discard them?")) return;
    setSelected(u.id);
    setDraft(u.tiles);
  };

  /** The group grants in the registry, and what each one covers. */
  const groupGrants = useMemo(
    () => (data?.registry ?? []).filter((t) => t.isGroupGrant),
    [data],
  );

  /** The group grant currently conferring `key`, if one is ticked. */
  const impliedBy = (key: string): RegistryTile | undefined =>
    groupGrants.find((g) => draft.includes(g.key) && g.covers.includes(key));

  /**
   * How many tiles a stored grant list actually opens. A group grant is ONE row
   * but confers twelve, so counting rows would under-report access — the exact
   * number someone would use to decide whether a person can see payroll.
   */
  const effectiveCount = (stored: string[]): number => {
    const out = new Set(stored);
    for (const g of groupGrants) {
      if (out.has(g.key)) {
        out.delete(g.key);
        for (const k of g.covers) out.add(k);
      }
    }
    return out.size;
  };

  const toggle = (t: RegistryTile) =>
    setDraft((d) => {
      const next = new Set(d);
      if (next.has(t.key)) {
        next.delete(t.key);
        // Un-ticking a group must clear what it conferred, or the children linger
        // as stale rows and the person keeps access they appear to have lost.
        if (t.isGroupGrant) for (const k of t.covers) next.delete(k);
      } else {
        next.add(t.key);
        // Ticking a group folds its children into it. The server stores only the
        // group key, so leaving children in the draft would make the panel show
        // ticks that never persisted.
        if (t.isGroupGrant) for (const k of t.covers) next.delete(k);
      }
      return [...next];
    });

  /** Grant or revoke everything grantable in one move. */
  const setAll = (on: boolean) =>
    setDraft(
      on
        ? (data?.registry ?? [])
            .filter((t) => !t.ownerOnly)
            // Prefer the group grant over the twelve it covers.
            .filter((t) => t.isGroupGrant || !groupGrants.some((g) => g.covers.includes(t.key)))
            .map((t) => t.key)
        : [],
    );

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
                      <span
                        className={
                          "block truncate font-medium " +
                          (u.isActive ? "text-brand-navy" : "text-neutral-400")
                        }
                      >
                        {u.email}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {u.isOwner ? "owner" : u.isAdmin ? "admin" : u.role}
                        {u.isActive ? "" : " · inactive"}
                      </span>
                    </span>
                    {/* The owner holds everything implicitly and has no grant
                        rows, so a bare "0" here reads as locked out. */}
                    <span className="fin-num ml-2 shrink-0 text-xs text-neutral-400">
                      {u.isOwner ? "all" : effectiveCount(u.tiles)}
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
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-semibold text-brand-navy">
                        {current.email}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        last signed in {when(current.lastLoginAt)}
                        {current.isOwner
                          ? " · owner — holds every tile regardless of what is ticked here"
                          : ""}
                        {current.isActive ? "" : " · inactive — cannot sign in"}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span
                        className={
                          "text-xs font-medium " +
                          (dirty ? "text-brand-orange" : "text-neutral-400")
                        }
                      >
                        {dirty ? `${changeCount} unsaved` : "All changes saved"}
                      </span>
                      <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>
                        {saving ? "Saving…" : "Save changes"}
                      </Button>
                    </div>
                  </div>

                  <div className="mb-4 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setAll(true)}
                      className="rounded-md px-2.5 py-1 text-xs font-medium text-brand-navy ring-1 ring-border hover:bg-muted"
                    >
                      Everything
                    </button>
                    <button
                      type="button"
                      onClick={() => setAll(false)}
                      className="rounded-md px-2.5 py-1 text-xs font-medium text-brand-navy ring-1 ring-border hover:bg-muted"
                    >
                      Nothing
                    </button>
                    {current.isOwner && (
                      <span className="text-xs text-muted-foreground">
                        Ticks here do not restrict the owner.
                      </span>
                    )}
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
                            {inGroup.map((t) => {
                              const covered = impliedBy(t.key);
                              // A covered child is not independently toggleable:
                              // the server stores only the group key, so a tick
                              // here would silently fail to persist.
                              const locked = t.ownerOnly || covered != null;
                              return (
                                <label
                                  key={t.key}
                                  title={t.blurb}
                                  className={
                                    "flex items-start gap-2 rounded-md px-1.5 py-1 text-sm " +
                                    (locked ? "opacity-60" : "cursor-pointer hover:bg-muted")
                                  }
                                >
                                  <input
                                    type="checkbox"
                                    className="mt-0.5"
                                    disabled={locked}
                                    checked={
                                      !t.ownerOnly && (draft.includes(t.key) || covered != null)
                                    }
                                    onChange={() => toggle(t)}
                                  />
                                  <span>
                                    <span
                                      className={
                                        t.isGroupGrant
                                          ? "font-medium text-brand-navy"
                                          : "text-brand-navy"
                                      }
                                    >
                                      {t.title}
                                    </span>
                                    {t.isGroupGrant && (
                                      <span className="block text-xs text-muted-foreground">
                                        {t.blurb}
                                      </span>
                                    )}
                                    {covered && (
                                      <span className="block text-xs text-muted-foreground">
                                        Included by {covered.title}
                                      </span>
                                    )}
                                    {t.ownerOnly && (
                                      <span className="block text-xs text-muted-foreground">
                                        Owner only — never grantable
                                      </span>
                                    )}
                                    {!locked && t.adminOnly && !current.isAdmin && (
                                      <span className="block text-xs text-muted-foreground">
                                        Also needs admin
                                      </span>
                                    )}
                                  </span>
                                </label>
                              );
                            })}
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
