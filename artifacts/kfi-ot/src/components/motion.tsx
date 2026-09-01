// Motion + skeleton primitives — small on purpose: four CSS dials in
// index.css do the timing, these just put the right class on the right thing
// at the right moment. Ported from the KFI dashboard design language
// (KFI-Housing's refinement of it).
import { type ReactNode, useEffect, useState } from "react";

export const reducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Keep a subtree mounted for `ms` after `open` goes false, so it can play its
 * exit before it disappears.
 */
export function useDelayedUnmount(open: boolean, ms: number): boolean {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    if (reducedMotion()) {
      setMounted(false);
      return;
    }
    const t = window.setTimeout(() => setMounted(false), ms);
    return () => window.clearTimeout(t);
  }, [open, ms]);
  return mounted || open;
}

/** Content that has just arrived. `index` staggers a list without hand-math. */
export function Reveal(props: { children: ReactNode; index?: number; className?: string }) {
  const i = Math.min(props.index ?? 0, 12);
  return (
    <div
      className={`reveal ${props.className ?? ""}`}
      style={i ? { animationDelay: `calc(${i} * var(--stagger))` } : undefined}
    >
      {props.children}
    </div>
  );
}

/**
 * Expand/collapse without measuring anything: a one-row grid eased from 0fr
 * to 1fr. Children unmount only after the close finishes.
 */
export function Collapse(props: { open: boolean; children: ReactNode; className?: string }) {
  const mounted = useDelayedUnmount(props.open, 340);
  return (
    <div
      className={`grid transition-[grid-template-rows,opacity] duration-[var(--dur-in)] ease-[var(--ease-out)] ${
        props.open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
      } ${props.className ?? ""}`}
    >
      <div className="overflow-hidden">{mounted ? props.children : null}</div>
    </div>
  );
}

/** The ▸/▾ marker, rotated rather than swapped — a glyph swap is a flicker. */
export function Caret(props: { open: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block transition-[rotate] duration-[var(--dur-in)] ease-[var(--ease-out)] ${
        props.open ? "rotate-90" : ""
      } ${props.className ?? ""}`}
    >
      ▸
    </span>
  );
}

// ── Skeletons — shaped like the thing that is coming, so when the data lands
// nothing moves. Never a spinner, which says "wait" without saying what for.

export function Skeleton(props: { className?: string }) {
  return <div className={`skeleton ${props.className ?? ""}`} aria-hidden />;
}

/** The stat strip above a board. */
export function SkeletonStats(props: { n?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {Array.from({ length: props.n ?? 4 }, (_, i) => (
        <div key={i} className="surface rounded-card p-4 ring-1 ring-brand-line">
          <Skeleton className="h-2.5 w-16" />
          <Skeleton className="mt-2.5 h-7 w-20" />
        </div>
      ))}
    </div>
  );
}

/** A table ghost, in the card shell the real table will land in. */
export function SkeletonTable(props: { rows?: number; cols?: number; className?: string }) {
  const cols = props.cols ?? 4;
  return (
    <div className={`surface overflow-hidden rounded-card ring-1 ring-brand-line ${props.className ?? ""}`}>
      <div className="band flex items-center gap-2.5 px-4 py-3">
        <Skeleton className="h-3 w-40" />
      </div>
      {Array.from({ length: props.rows ?? 8 }, (_, r) => (
        <div key={r} className="flex items-center gap-4 border-b border-brand-line/70 px-4 py-2.5">
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton key={c} className={`h-3 ${c === 0 ? "w-1/3" : "flex-1"}`} />
          ))}
        </div>
      ))}
    </div>
  );
}
