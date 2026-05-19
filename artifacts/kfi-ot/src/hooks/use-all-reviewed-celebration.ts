import { useEffect, useState } from "react";
import { readCelebrationSoundPref } from "./use-celebration-sound";

// Module-level so the "already celebrated for this week" memory survives
// React unmounts as the dispatcher walks between week-summary and
// driver-detail pages. Per-tab is intentional — a hard refresh wipes it,
// which is fine: the celebration is for the moment of transition only.
//
// Keyed by (weekStart, surface) so each page tracks its own baseline.
// Otherwise whichever page first observed the week would "win" and the
// other page would silently skip celebrating — e.g. opening driver-detail
// records baseline=true, then toggling the last driver from the dashboard
// would never fire because the dashboard never recorded its own baseline.
const seenAllReviewed = new Map<string, boolean>();

type Surface = "week-summary" | "driver-detail";

function keyFor(weekStart: string, surface: Surface): string {
  return `${surface}::${weekStart}`;
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function playCelebrationChime(): void {
  if (typeof window === "undefined") return;
  try {
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    // Short two-note arpeggio (E5 -> A5), gentle sine, ~450ms total,
    // peak gain 0.12 so it stays well below a notification "ding".
    const now = ctx.currentTime;
    const notes: Array<{ freq: number; start: number; dur: number }> = [
      { freq: 659.25, start: 0, dur: 0.22 },
      { freq: 880.0, start: 0.12, dur: 0.32 },
    ];
    for (const n of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = n.freq;
      const t0 = now + n.start;
      const t1 = t0 + n.dur;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(0.12, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t1);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t1 + 0.02);
    }
    window.setTimeout(() => {
      try {
        void ctx.close();
      } catch {
        // ignore
      }
    }, 800);
  } catch {
    // sound is best-effort
  }
}

async function fireConfettiBurst(): Promise<void> {
  try {
    const mod = await import("canvas-confetti");
    const confetti = mod.default;
    const end = Date.now() + 700;
    const colors = ["#14b8a6", "#0f766e", "#fbbf24", "#ffffff", "#1e3a8a"];
    const frame = () => {
      confetti({
        particleCount: 5,
        angle: 60,
        spread: 60,
        startVelocity: 45,
        origin: { x: 0, y: 0.65 },
        colors,
      });
      confetti({
        particleCount: 5,
        angle: 120,
        spread: 60,
        startVelocity: 45,
        origin: { x: 1, y: 0.65 },
        colors,
      });
      if (Date.now() < end) requestAnimationFrame(frame);
    };
    frame();
  } catch {
    // confetti is best-effort
  }
}

interface Args {
  weekStart: string | null | undefined;
  reviewed: number;
  total: number;
  surface: Surface;
}

/**
 * Fires a one-shot confetti burst + splash banner when the week transitions
 * from "not all reviewed" to "all reviewed" within the current tab session.
 *
 * - Tracks last-seen state per weekStart so switching weeks doesn't
 *   misfire (entering an already-all-reviewed week is silent).
 * - Skips confetti when `prefers-reduced-motion: reduce`, but the splash
 *   still appears.
 * - Auto-dismisses the splash after a few seconds.
 */
export function useAllReviewedCelebration({
  weekStart,
  reviewed,
  total,
  surface,
}: Args): { splashVisible: boolean; dismiss: () => void } {
  const [splashVisible, setSplashVisible] = useState(false);

  useEffect(() => {
    if (!weekStart) return;
    if (total <= 0) return;
    const isAll = reviewed >= total;
    const key = keyFor(weekStart, surface);
    const prev = seenAllReviewed.get(key);

    if (prev === undefined) {
      // First observation of this week on this surface — record without firing.
      seenAllReviewed.set(key, isAll);
      return;
    }

    if (!prev && isAll) {
      seenAllReviewed.set(key, true);
      const reducedMotion = prefersReducedMotion();
      if (!reducedMotion) {
        void fireConfettiBurst();
      }
      if (!reducedMotion && readCelebrationSoundPref()) {
        playCelebrationChime();
      }
      setSplashVisible(true);
    } else if (prev !== isAll) {
      // Drop back to not-all-reviewed — re-arm so the next completion fires.
      seenAllReviewed.set(key, isAll);
    }
  }, [weekStart, reviewed, total, surface]);

  useEffect(() => {
    if (!splashVisible) return;
    const handle = window.setTimeout(() => setSplashVisible(false), 4500);
    return () => window.clearTimeout(handle);
  }, [splashVisible]);

  return { splashVisible, dismiss: () => setSplashVisible(false) };
}
