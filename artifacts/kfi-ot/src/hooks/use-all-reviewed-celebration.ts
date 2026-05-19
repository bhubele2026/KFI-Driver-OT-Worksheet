import { useEffect, useState } from "react";
import { readCelebrationSoundPref } from "./use-celebration-sound";

// Module-level so the "already celebrated for this week" memory survives
// React unmounts as the dispatcher walks between week-summary and
// driver-detail pages. Per-tab is intentional — a hard refresh wipes it,
// which is fine: the celebration is for the moment of transition only.
//
// Keyed by (kind, weekStart, surface) so each (signal, page) pair tracks
// its own baseline. Otherwise whichever page first observed the week would
// "win" and the other page would silently skip celebrating — e.g. opening
// driver-detail records baseline=true, then toggling the last driver from
// the dashboard would never fire because the dashboard never recorded its
// own baseline. Splitting by kind ("all-reviewed" vs "fully-reconciled")
// keeps each milestone independent so neither steals the other's moment.
const seenState = new Map<string, boolean>();

type Surface = "week-summary" | "driver-detail";
type Kind = "all-reviewed" | "fully-reconciled";

function keyFor(kind: Kind, weekStart: string, surface: Surface): string {
  return `${kind}::${surface}::${weekStart}`;
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function playCelebrationChime(variant: "soft" | "bright"): void {
  if (typeof window === "undefined") return;
  try {
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const now = ctx.currentTime;
    // "soft" is the existing two-note arpeggio (E5 -> A5).
    // "bright" is a three-note ascending C5 -> E5 -> G5 for the bigger
    // fully-reconciled moment, still well below a notification "ding".
    const notes: Array<{ freq: number; start: number; dur: number }> =
      variant === "bright"
        ? [
            { freq: 523.25, start: 0, dur: 0.18 },
            { freq: 659.25, start: 0.1, dur: 0.2 },
            { freq: 783.99, start: 0.22, dur: 0.42 },
          ]
        : [
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
    }, 1200);
  } catch {
    // sound is best-effort
  }
}

async function fireConfettiBurst(variant: "soft" | "bright"): Promise<void> {
  try {
    const mod = await import("canvas-confetti");
    const confetti = mod.default;
    // Bright variant runs longer with a denser stream and a gold-leaning
    // palette so the "ready for payroll" moment reads as bigger than the
    // all-reviewed checkpoint.
    const durationMs = variant === "bright" ? 1400 : 700;
    const particleCount = variant === "bright" ? 8 : 5;
    const colors =
      variant === "bright"
        ? ["#fbbf24", "#f59e0b", "#fde68a", "#ffffff", "#14b8a6"]
        : ["#14b8a6", "#0f766e", "#fbbf24", "#ffffff", "#1e3a8a"];
    const end = Date.now() + durationMs;
    const frame = () => {
      confetti({
        particleCount,
        angle: 60,
        spread: 65,
        startVelocity: 50,
        origin: { x: 0, y: 0.65 },
        colors,
      });
      confetti({
        particleCount,
        angle: 120,
        spread: 65,
        startVelocity: 50,
        origin: { x: 1, y: 0.65 },
        colors,
      });
      if (Date.now() < end) requestAnimationFrame(frame);
    };
    frame();
    if (variant === "bright") {
      // A central celebratory burst on top of the side cannons, so the
      // moment reads distinctly different from the all-reviewed splash.
      window.setTimeout(() => {
        confetti({
          particleCount: 80,
          spread: 100,
          startVelocity: 35,
          origin: { x: 0.5, y: 0.4 },
          colors,
          scalar: 1.1,
        });
      }, 150);
    }
  } catch {
    // confetti is best-effort
  }
}

function useTransitionCelebration(
  kind: Kind,
  args: {
    weekStart: string | null | undefined;
    active: boolean;
    eligible: boolean;
    surface: Surface;
    variant: "soft" | "bright";
    autoDismissMs: number;
  },
): { splashVisible: boolean; dismiss: () => void } {
  const { weekStart, active, eligible, surface, variant, autoDismissMs } =
    args;
  const [splashVisible, setSplashVisible] = useState(false);

  useEffect(() => {
    if (!weekStart) return;
    if (!eligible) return;
    const key = keyFor(kind, weekStart, surface);
    const prev = seenState.get(key);

    if (prev === undefined) {
      // First observation of this week on this surface — record baseline
      // without firing. Entering an already-satisfied week is silent.
      seenState.set(key, active);
      return;
    }

    if (!prev && active) {
      seenState.set(key, true);
      const reducedMotion = prefersReducedMotion();
      if (!reducedMotion) {
        void fireConfettiBurst(variant);
      }
      if (!reducedMotion && readCelebrationSoundPref()) {
        playCelebrationChime(variant);
      }
      setSplashVisible(true);
    } else if (prev !== active) {
      // Drop back to not-satisfied — re-arm so the next transition fires.
      seenState.set(key, active);
    }
  }, [kind, weekStart, active, eligible, surface, variant]);

  useEffect(() => {
    if (!splashVisible) return;
    const handle = window.setTimeout(
      () => setSplashVisible(false),
      autoDismissMs,
    );
    return () => window.clearTimeout(handle);
  }, [splashVisible, autoDismissMs]);

  return { splashVisible, dismiss: () => setSplashVisible(false) };
}

interface AllReviewedArgs {
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
}: AllReviewedArgs): { splashVisible: boolean; dismiss: () => void } {
  return useTransitionCelebration("all-reviewed", {
    weekStart,
    active: reviewed >= total,
    eligible: total > 0,
    surface,
    variant: "soft",
    autoDismissMs: 4500,
  });
}

interface FullyReconciledArgs {
  weekStart: string | null | undefined;
  /** True when all drivers reviewed AND zero outstanding alerts. */
  fullyReconciled: boolean;
  /** Whether the underlying data has loaded enough to trust `fullyReconciled`. */
  ready: boolean;
  surface: Surface;
}

/**
 * Fires a bigger, distinctly styled celebration when the week transitions
 * to "fully reconciled" — all drivers reviewed AND zero outstanding alerts
 * (driver/customer mismatches, Connecteam parity differs, unmapped badges,
 * stale Connecteam baseline). This is the real finish line for payroll, so
 * we mark it as a more emphatic moment than the all-reviewed checkpoint.
 *
 * The bookkeeping is independent from `useAllReviewedCelebration` so
 * neither signal steals the other's moment — both can fire on the same
 * review toggle if it happens to satisfy both transitions at once.
 */
export function useFullyReconciledCelebration({
  weekStart,
  fullyReconciled,
  ready,
  surface,
}: FullyReconciledArgs): { splashVisible: boolean; dismiss: () => void } {
  return useTransitionCelebration("fully-reconciled", {
    weekStart,
    active: fullyReconciled,
    eligible: ready,
    surface,
    variant: "bright",
    autoDismissMs: 6000,
  });
}
