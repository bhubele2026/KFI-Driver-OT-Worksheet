import { useCallback, useEffect, useRef, useState } from "react";
import { postEditing, subscribeRealtime } from "@/lib/realtime";

interface EditingClaim {
  punchId: number | null;
  email: string;
  expiresAt: number;
}

interface Args {
  weekStart: string | null | undefined;
  kfiId: string | null | undefined;
  selfEmail?: string | null;
}

/**
 * Track who-is-editing-what for the active driver-week. Also exposes
 * imperative `claim()` / `release()` helpers callers can wire into the
 * inline-edit affordances so the indicator shows up as soon as a
 * dispatcher clicks "edit" — not only after the first PATCH lands.
 */
export function useEditingLock({ weekStart, kfiId, selfEmail }: Args) {
  const [claims, setClaims] = useState<EditingClaim[]>([]);
  const selfEmailRef = useRef(selfEmail);
  selfEmailRef.current = selfEmail;
  // Track our own active claims so we can heartbeat them. Server TTL is
  // ~12s; we re-send "start" every 5s while the dispatcher is still
  // engaged (kept alive on activity via touchActivity below).
  const myClaimsRef = useRef<Map<number | null, number>>(new Map());
  const weekStartRef = useRef<string | null | undefined>(weekStart);
  const kfiIdRef = useRef<string | null | undefined>(kfiId);
  weekStartRef.current = weekStart;
  kfiIdRef.current = kfiId;

  useEffect(() => {
    // Clear stale claims whenever the dispatcher navigates to a different
    // driver/week — punch IDs can repeat across drivers, so a leftover
    // claim from the previous page would otherwise light up the wrong row.
    setClaims([]);
    if (!weekStart || !kfiId) return;
    const unsub = subscribeRealtime({
      weekStart,
      kfiId,
      handler: (event) => {
        if (event.type !== "editing") return;
        if (event.weekStart !== weekStart || event.kfiId !== kfiId) return;
        if (event.actor.email === selfEmailRef.current) return;
        setClaims((prev) => {
          const filtered = prev.filter(
            (c) =>
              !(c.email === event.actor.email && c.punchId === event.punchId),
          );
          if (event.action === "start") {
            filtered.push({
              email: event.actor.email,
              punchId: event.punchId,
              expiresAt: new Date(event.expiresAt).getTime(),
            });
          }
          return filtered;
        });
      },
    });
    return () => {
      unsub();
    };
  }, [weekStart, kfiId]);

  // Prune expired claims locally — server pubs only fire on action, so a
  // stale claim from a closed tab needs client-side garbage collection too.
  useEffect(() => {
    const id = window.setInterval(() => {
      const nowMs = Date.now();
      setClaims((prev) => prev.filter((c) => c.expiresAt > nowMs));
    }, 2_000);
    return () => window.clearInterval(id);
  }, []);

  const claim = useCallback(
    (punchId: number | null) => {
      if (!weekStart || !kfiId) return;
      myClaimsRef.current.set(punchId, Date.now());
      void postEditing({ weekStart, kfiId, punchId, action: "start" });
    },
    [weekStart, kfiId],
  );
  const release = useCallback(
    (punchId: number | null) => {
      if (!weekStart || !kfiId) return;
      myClaimsRef.current.delete(punchId);
      void postEditing({ weekStart, kfiId, punchId, action: "stop" });
    },
    [weekStart, kfiId],
  );

  // Heartbeat: every 5s, re-send "start" for each of our open claims as
  // long as it has seen activity within ~10s. This keeps the server TTL
  // (12s) from expiring during a long edit, while still letting the row
  // free up automatically once the dispatcher stops typing. Inactive
  // claims also get auto-released so a forgotten dialog doesn't pin the
  // row indefinitely.
  useEffect(() => {
    const id = window.setInterval(() => {
      const ws = weekStartRef.current;
      const kf = kfiIdRef.current;
      if (!ws || !kf) return;
      const nowMs = Date.now();
      for (const [punchId, lastTouched] of myClaimsRef.current.entries()) {
        if (nowMs - lastTouched > 10_000) {
          myClaimsRef.current.delete(punchId);
          void postEditing({ weekStart: ws, kfiId: kf, punchId, action: "stop" });
          continue;
        }
        void postEditing({ weekStart: ws, kfiId: kf, punchId, action: "start" });
      }
    }, 5_000);
    return () => window.clearInterval(id);
  }, []);

  // Bump activity timestamp for an open claim. UI calls this on
  // keystrokes/focus so the heartbeat keeps the lock alive.
  const touchActivity = useCallback((punchId: number | null) => {
    if (!myClaimsRef.current.has(punchId)) return;
    myClaimsRef.current.set(punchId, Date.now());
  }, []);

  const editorsForPunch = useCallback(
    (punchId: number | null): string[] => {
      return claims.filter((c) => c.punchId === punchId).map((c) => c.email);
    },
    [claims],
  );

  return { claims, claim, release, editorsForPunch, touchActivity };
}
