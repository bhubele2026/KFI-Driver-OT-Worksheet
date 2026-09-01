import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Caret, Collapse, Skeleton } from "@/components/motion";
import { useAccess, invalidateAccess } from "@/lib/access";
import { guardedFetch } from "@/lib/session";

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
interface ActivityEvent {
  email: string;
  tile: string;
  kind: string;
  detail: string | null;
  source: string;
  at: string;
}
interface Activity {
  days: number;
  totalOpens: number;
  totalInteractions: number;
  byUser: Array<{
    email: string;
    total: number;
    interactions: number;
    lastActive: string;
    tiles: Array<{ tile: string; count: number }>;
  }>;
  byTile: Array<{ tile: string; count: number; interactions: number; users: number }>;
  recent: ActivityEvent[];
  recentTotal: number;
  signIns: Array<{ email: string; at: string }>;
}

const api = (p: string) => `${import.meta.env.BASE_URL}api${p}`;
const firstName = (email: string) => {
  const raw = email.split("@")[0].split(/[._]/)[0] ?? email;
  return raw.replace(/^\w/, (ch) => ch.toUpperCase());
};
const when = (v: string | null) => (v ? new Date(v).toLocaleString() : "never");
const fmtWhen = (iso: string): string =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Sign-ins bucketed by the viewer's local day, latest time per person per day. */
function groupSignIns(signIns: Activity["signIns"]) {
  const byDay = new Map<string, Map<string, { email: string; at: string }>>();
  for (const s of signIns) {
    const d = new Date(s.at);
    const dayKey = d.toLocaleDateString();
    if (!byDay.has(dayKey)) byDay.set(dayKey, new Map());
    const m = byDay.get(dayKey)!;
    const prev = m.get(s.email);
    if (!prev || new Date(prev.at) < d) m.set(s.email, s);
  }
  const todayKey = new Date().toLocaleDateString();
  const yestKey = new Date(Date.now() - 864e5).toLocaleDateString();
  return [...byDay.entries()]
    .sort((a, b) => (new Date(a[0]) < new Date(b[0]) ? 1 : -1))
    .slice(0, 10)
    .map(([day, m]) => ({
      label:
        day === todayKey
          ? "Today"
          : day === yestKey
            ? "Yesterday"
            : new Date(day).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }),
      today: day === todayKey,
      people: [...m.values()].sort((a, b) => (a.at < b.at ? 1 : -1)),
    }));
}

export default function AdminAccess() {
  const [, setLocation] = useLocation();
  const access = useAccess();
  const [tab, setTab] = useState<"access" | "activity">("access");
  const [data, setData] = useState<AccessPayload | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [draft, setDraft] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  // Owner-only surface. The server enforces it too; this is just the UI.
  useEffect(() => {
    if (access && !access.isOwner) setLocation("/");
  }, [access, setLocation]);

  const load = () =>
    guardedFetch(api("/admin/tile-access"))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: AccessPayload) => setData(d))
      .catch(() => setData(null));

  useEffect(() => {
    void load();
  }, []);

  /** Board name for an event key — registry titles, plus the pseudo-tiles. */
  const tileName = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of data?.registry ?? []) m.set(t.key, t.title);
    return (k: string) => (k === "home" ? "Home" : k === "settings" ? "Settings" : (m.get(k) ?? k));
  }, [data]);

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
   * but confers twelve, so counting rows would under-report access. Keys no
   * longer in the registry (e.g. the retired `settings` tile) confer nothing
   * and are not counted.
   */
  const effectiveCount = (stored: string[]): number => {
    const known = new Set((data?.registry ?? []).map((t) => t.key));
    const out = new Set(stored.filter((k) => known.has(k)));
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
      const r = await guardedFetch(api("/admin/user-tiles"), {
        method: "POST",
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
          <h1 className="text-display font-semibold tracking-tight text-brand-navy">
            Access &amp; activity
          </h1>
          <p className="mt-1 text-body text-neutral-500">
            Who can see which boards, and what everyone has been doing.
          </p>
        </div>

        <div className="flex gap-1">
          {(["access", "activity"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={
                "press rounded-control px-3 py-1.5 text-body font-medium " +
                (tab === k
                  ? "bg-brand-navy text-white shadow-rest"
                  : "text-neutral-500 hover:bg-brand-wash hover:text-brand-navy")
              }
            >
              {k === "access" ? "Access" : "Activity"}
            </button>
          ))}
        </div>

        {tab === "access" ? (
          <div className="grid gap-5 lg:grid-cols-[22rem_minmax(0,1fr)]">
            {/* People */}
            <div className="surface rounded-card p-4 ring-1 ring-brand-line">
              <div className="mb-2 text-micro font-semibold uppercase tracking-[0.08em] text-neutral-500">
                People
              </div>
              <div className="space-y-1">
                {(data?.users ?? []).map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => pick(u)}
                    className={
                      "press flex w-full items-center justify-between rounded-control px-2.5 py-2 text-left text-body " +
                      (selected === u.id ? "bg-brand-wash ring-1 ring-brand-navy/25" : "hover:bg-brand-tint")
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
                      <span className="block text-micro text-neutral-500">
                        {u.isOwner ? "owner" : u.isAdmin ? "admin" : u.role}
                        {u.isActive ? "" : " · inactive"}
                      </span>
                    </span>
                    {/* The owner holds everything implicitly and has no grant
                        rows, so a bare "0" here reads as locked out. */}
                    <span className="fin-num ml-2 shrink-0 text-micro text-neutral-400">
                      {u.isOwner ? "all" : effectiveCount(u.tiles)}
                    </span>
                  </button>
                ))}
                {!data && (
                  <div className="space-y-1.5">
                    {[0, 1, 2, 3].map((i) => (
                      <Skeleton key={i} className="h-10 w-full rounded-control" />
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Their tiles */}
            <div className="surface rounded-card p-5 ring-1 ring-brand-line">
              {!current ? (
                <p className="text-body text-neutral-500">
                  Pick a person to set which boards they see.
                </p>
              ) : (
                <>
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-semibold text-brand-navy">
                        {current.email}
                      </div>
                      <div className="text-micro text-neutral-500">
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
                          "text-micro font-medium " +
                          (dirty ? "text-bad" : "text-neutral-400")
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
                      className="press rounded-control px-2.5 py-1 text-micro font-medium text-brand-navy ring-1 ring-brand-line hover:bg-brand-tint"
                    >
                      Everything
                    </button>
                    <button
                      type="button"
                      onClick={() => setAll(false)}
                      className="press rounded-control px-2.5 py-1 text-micro font-medium text-brand-navy ring-1 ring-brand-line hover:bg-brand-tint"
                    >
                      Nothing
                    </button>
                    {current.isOwner && (
                      <span className="text-micro text-neutral-500">
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
                          <div className="mb-2 text-micro font-semibold uppercase tracking-[0.08em] text-neutral-500">
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
                                    "flex items-start gap-2 rounded-control px-1.5 py-1 text-body " +
                                    (locked ? "opacity-60" : "cursor-pointer hover:bg-brand-tint")
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
                                      <span className="block text-micro text-neutral-500">
                                        {t.blurb}
                                      </span>
                                    )}
                                    {covered && (
                                      <span className="block text-micro text-neutral-500">
                                        Included by {covered.title}
                                      </span>
                                    )}
                                    {t.ownerOnly && (
                                      <span className="block text-micro text-neutral-500">
                                        Owner only — never grantable
                                      </span>
                                    )}
                                    {!locked && t.adminOnly && !current.isAdmin && (
                                      <span className="block text-micro text-neutral-500">
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
          <ActivityView tileName={tileName} />
        )}
      </div>
    </AppShell>
  );
}

/**
 * The owner's view of who has been where — sign-ins by day, most-used boards,
 * EVERY CLICK as a sentence, and a per-person breakdown. Ported from the
 * Financial Dashboard's activity page via KFI-Housing's refinement of it.
 */
function ActivityView({ tileName }: { tileName: (k: string) => string }) {
  const [days, setDays] = useState(30);
  const [includeOwner, setIncludeOwner] = useState(false);
  const [limit, setLimit] = useState(400);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  // With every press logged, an unfiltered feed is a firehose: filter to one
  // person or one board, and pull more rather than stop at an invisible cap.
  const [who, setWho] = useState<string | null>(null);
  const [board, setBoard] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void guardedFetch(
      api(`/admin/tile-activity?days=${days}&includeOwner=${includeOwner ? "1" : "0"}&limit=${limit}`),
    )
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: Activity) => alive && setActivity(d))
      .catch(() => alive && setActivity(null))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [days, includeOwner, limit]);

  const d = activity;
  const signInDays = useMemo(() => (d ? groupSignIns(d.signIns) : []), [d]);
  const shownEvents = useMemo(
    () => (d?.recent ?? []).filter((e) => (!who || e.email === who) && (!board || e.tile === board)),
    [d, who, board],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex overflow-hidden rounded-control ring-1 ring-brand-line">
          {[7, 30, 90].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setDays(n)}
              className={`press fin-num px-3 py-1 text-micro font-medium ${
                days === n ? "bg-brand-navy text-white" : "bg-white text-neutral-500 hover:text-brand-navy"
              }`}
            >
              {n}d
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-micro text-neutral-500">
          <input
            type="checkbox"
            checked={includeOwner}
            onChange={(e) => setIncludeOwner(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          include my own clicks
        </label>
        <span className="flex-1" />
        {d && (
          <span className="fin-num text-micro text-neutral-400">
            {d.totalOpens.toLocaleString()} board opens · {d.totalInteractions.toLocaleString()} clicks · last {d.days} days
          </span>
        )}
      </div>

      {loading && !d && (
        <div className="space-y-1.5">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-6 w-full" />
          ))}
        </div>
      )}

      {d && (
        <>
          <section className="surface rounded-card p-5 ring-1 ring-brand-line">
            <h3 className="mb-2.5 text-micro font-semibold uppercase tracking-[0.08em] text-neutral-500">
              Signed in
            </h3>
            {signInDays.length === 0 && (
              <p className="text-body text-neutral-400">No sign-ins in this window.</p>
            )}
            <div className="space-y-1.5">
              {signInDays.map((day) => (
                <div key={day.label} className="flex flex-wrap items-baseline gap-1.5">
                  <span
                    className={`w-24 shrink-0 text-micro font-semibold uppercase tracking-[0.08em] ${
                      day.today ? "text-brand-navy" : "text-neutral-400"
                    }`}
                  >
                    {day.label}
                  </span>
                  {day.people.map((p) => (
                    <span
                      key={p.email}
                      title={p.email}
                      className={`rounded-full px-2 py-0.5 text-micro ${
                        day.today
                          ? "bg-brand-wash text-brand-navy ring-1 ring-brand-line"
                          : "bg-brand-tint text-neutral-600"
                      }`}
                    >
                      {firstName(p.email)} ·{" "}
                      {new Date(p.at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                    </span>
                  ))}
                </div>
              ))}
            </div>
          </section>

          <section className="surface rounded-card p-5 ring-1 ring-brand-line">
            <h3 className="mb-2.5 text-micro font-semibold uppercase tracking-[0.08em] text-neutral-500">
              Most-used boards
            </h3>
            {d.byTile.length === 0 && (
              <p className="text-body text-neutral-400">
                No board activity from others in this window — your own is hidden unless
                &quot;include my own clicks&quot; is on.
              </p>
            )}
            <div className="space-y-1.5">
              {d.byTile.map((t) => {
                const max = Math.max(...d.byTile.map((x) => x.count), 1);
                return (
                  <div key={t.tile} className="flex items-center gap-2 text-micro">
                    <span className="w-36 shrink-0 truncate text-neutral-600">{tileName(t.tile)}</span>
                    <div
                      className="grow-bar h-3.5 rounded-sm bg-brand-navy"
                      style={{ width: `${Math.max(2, (t.count / max) * 100)}%` }}
                    />
                    <span className="fin-num shrink-0 text-neutral-500">
                      {t.count} · {t.users} {t.users === 1 ? "person" : "people"}
                      {t.interactions > 0 && ` · ${t.interactions} clicks`}
                    </span>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="surface rounded-card p-5 ring-1 ring-brand-line">
            <div className="mb-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h3 className="text-micro font-semibold uppercase tracking-[0.08em] text-neutral-500">
                Every click
              </h3>
              {/* Say how much of it you're looking at, and page instead of
                  quietly stopping. */}
              <span className="fin-num text-micro text-neutral-400">
                {shownEvents.length === d.recentTotal
                  ? `all ${d.recentTotal.toLocaleString()}`
                  : `${shownEvents.length.toLocaleString()} of ${d.recentTotal.toLocaleString()}`}
              </span>
              <span className="flex-1" />
              {(who || board) && (
                <button
                  type="button"
                  className="press text-micro font-medium text-brand-navy hover:underline"
                  onClick={() => {
                    setWho(null);
                    setBoard(null);
                  }}
                >
                  clear filter
                </button>
              )}
            </div>
            <div className="mb-2.5 flex flex-wrap gap-1.5">
              {d.byUser.map((u) => (
                <button
                  key={u.email}
                  type="button"
                  className={`press rounded-control px-2 py-0.5 text-micro font-medium ring-1 ${
                    who === u.email
                      ? "bg-brand-navy text-white ring-brand-navy"
                      : "bg-white text-neutral-600 ring-brand-line hover:text-brand-navy"
                  }`}
                  onClick={() => setWho(who === u.email ? null : u.email)}
                >
                  {firstName(u.email)}
                </button>
              ))}
              {[...new Set(d.recent.map((e) => e.tile))].sort().map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`press rounded-control px-2 py-0.5 text-micro font-medium ring-1 ${
                    board === t
                      ? "bg-brand-navy text-white ring-brand-navy"
                      : "bg-brand-tint text-neutral-500 ring-brand-line hover:text-brand-navy"
                  }`}
                  onClick={() => setBoard(board === t ? null : t)}
                >
                  {tileName(t)}
                </button>
              ))}
            </div>
            <div className="max-h-96 space-y-1 overflow-y-auto rounded-control bg-brand-tint/70 p-3">
              {shownEvents.length === 0 && <p className="text-body text-neutral-400">Nothing yet.</p>}
              {shownEvents.map((e, i) => (
                <div key={i} className="flex items-baseline gap-2 text-micro text-neutral-600">
                  <span className="fin-num w-28 shrink-0 text-neutral-400">{fmtWhen(e.at)}</span>
                  <span className="font-medium text-brand-navy">{firstName(e.email)}</span>
                  {/* Reads as a sentence — what a person would say happened. */}
                  <span>
                    {e.kind === "open" ? (
                      `opened ${tileName(e.tile)}`
                    ) : e.kind === "click" ? (
                      <>
                        clicked <span className="font-medium text-neutral-700">{e.detail ?? "something"}</span>{" "}
                        on {tileName(e.tile)}
                      </>
                    ) : (
                      `${tileName(e.tile)} → ${e.kind}${e.detail ? `: ${e.detail}` : ""}`
                    )}
                  </span>
                  {e.source === "server" && (
                    <span className="rounded bg-warn-bg px-1 text-micro uppercase text-warn">approx</span>
                  )}
                </div>
              ))}
            </div>
            {d.recent.length < d.recentTotal && (
              <div className="mt-2 flex justify-center">
                <button
                  type="button"
                  className="press text-micro font-medium text-brand-navy hover:underline"
                  disabled={loading}
                  onClick={() => setLimit((n) => n + 400)}
                >
                  {loading ? "loading…" : `show ${Math.min(400, d.recentTotal - d.recent.length)} more`}
                </button>
              </div>
            )}
          </section>

          <section className="surface rounded-card p-5 ring-1 ring-brand-line">
            <h3 className="mb-2.5 text-micro font-semibold uppercase tracking-[0.08em] text-neutral-500">
              By person
            </h3>
            {d.byUser.length === 0 && <p className="text-body text-neutral-400">No activity yet.</p>}
            <div className="space-y-1">
              {d.byUser.map((u) => (
                <div key={u.email} className="rounded-control ring-1 ring-brand-line/70">
                  <button
                    type="button"
                    className="press flex w-full items-baseline gap-2 px-3 py-2 text-left text-label"
                    onClick={() => setExpanded(expanded === u.email ? null : u.email)}
                  >
                    <Caret open={expanded === u.email} className="w-3 text-neutral-400" />
                    <span className="font-medium text-brand-navy">{firstName(u.email)}</span>
                    <span className="hidden text-neutral-400 sm:inline">{u.email}</span>
                    <span className="flex-1" />
                    <span className="fin-num text-neutral-500">
                      {u.total} board {u.total === 1 ? "open" : "opens"} · {u.interactions}{" "}
                      {u.interactions === 1 ? "click" : "clicks"} · last {fmtWhen(u.lastActive)}
                    </span>
                  </button>
                  <Collapse open={expanded === u.email}>
                    <div className="flex flex-wrap gap-1.5 border-t border-brand-line/60 px-3 py-2">
                      {u.tiles.map((t) => (
                        <span
                          key={t.tile}
                          className="rounded-full bg-brand-tint px-2 py-0.5 text-micro text-neutral-600"
                        >
                          {tileName(t.tile)} · {t.count}
                        </span>
                      ))}
                    </div>
                  </Collapse>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
