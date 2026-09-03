import { useEffect, useRef, useState } from "react";

/**
 * Animate a number from its previous value to `value` over ~1.2s with an
 * ease-out curve — the "live dashboard" feel on stat tiles and totals.
 * First render starts from 0; later changes glide from the old value.
 * Snaps instantly when the user prefers reduced motion.
 */
// ⚠️ 1200ms → 600ms (2026-09-03). This is a CORRECTNESS fix, not a pace one —
// index.css records "keep the animation slowness, I love it", and the shared
// motion dials there are deliberately untouched.
//
// With the ease-out cubic below, the displayed integer does not round to the
// true value until p > 0.777. At 1200ms a tile counting to 45 therefore showed
// a WRONG NUMBER for 933ms after the data had already landed. At 600ms that is
// 466ms. The tiles still count; they just stop lying for a second first.
export function useCountUp(value: number, durationMs = 600): number {
  const [display, setDisplay] = useState(0);
  const fromRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced || !Number.isFinite(value)) {
      fromRef.current = value;
      setDisplay(value);
      return;
    }
    const from = fromRef.current;
    if (from === value) {
      setDisplay(value);
      return;
    }
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
      setDisplay(from + (value - from) * eased);
      if (p < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = value;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      fromRef.current = value;
    };
  }, [value, durationMs]);

  return display;
}
