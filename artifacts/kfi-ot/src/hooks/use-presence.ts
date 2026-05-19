import { useEffect, useState } from "react";
import {
  postPresence,
  subscribeRealtime,
  type PresenceViewer,
} from "@/lib/realtime";

interface Args {
  weekStart: string | null | undefined;
  kfiId?: string | null;
}

/**
 * Presence beacon. POSTs `/presence` every 5s while the page is visible so
 * the server's 15s TTL keeps the user as a "viewer", and listens for
 * fan-out presence events so the chip stays in sync with every other tab on
 * the same week.
 */
export function usePresence({ weekStart, kfiId }: Args): PresenceViewer[] {
  const [viewers, setViewers] = useState<PresenceViewer[]>([]);

  useEffect(() => {
    if (!weekStart) return;
    let stopped = false;

    const beat = () => {
      if (document.visibilityState === "hidden") return;
      void postPresence(weekStart, kfiId ?? null);
    };
    beat();
    const interval = window.setInterval(beat, 5_000);

    const onVis = () => beat();
    document.addEventListener("visibilitychange", onVis);

    const unsub = subscribeRealtime({
      weekStart,
      kfiId: kfiId ?? null,
      handler: (event) => {
        if (event.type === "presence" && event.weekStart === weekStart) {
          if (stopped) return;
          // Server fans out the full week's viewer list; scope down to
          // viewers on this same driver-week when we have one, so the
          // driver-detail chip only shows people looking at this driver.
          const filtered = kfiId
            ? event.viewers.filter((v) => v.kfiId === kfiId)
            : event.viewers;
          setViewers(filtered);
        }
      },
    });

    return () => {
      stopped = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVis);
      unsub();
    };
  }, [weekStart, kfiId]);

  return viewers;
}
