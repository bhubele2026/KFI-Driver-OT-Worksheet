import { useEffect, useState } from "react";

/**
 * What the signed-in person may see.
 *
 * Hiding a tile here is NOT the security boundary — the server enforces it and
 * returns only the tiles you hold from /api/tiles. This is what stops the shell
 * of a tile (its name in the nav, its route) rendering for someone who has no
 * business seeing it.
 */
export interface TileDef {
  key: string;
  group: string;
  href: string;
  title: string;
  blurb: string;
  source: string;
  adminOnly?: boolean;
}

export interface Access {
  tiles: TileDef[];
  /** Every tile path in the registry, held or not — see the server comment. */
  gatedPaths: string[];
  isOwner: boolean;
  isAdmin: boolean;
  email: string | null;
}

// Fails CLOSED: a request that doesn't come back clean grants nothing.
const DENY: Access = { tiles: [], gatedPaths: [], isOwner: false, isAdmin: false, email: null };

let cache: Promise<Access> | null = null;

async function fetchAccess(): Promise<Access> {
  const r = await fetch(`${import.meta.env.BASE_URL}api/tiles`, {
    credentials: "include",
  });
  if (!r.ok) throw new Error(`tiles ${r.status}`);
  const d = (await r.json()) as Partial<Access>;
  return {
    tiles: Array.isArray(d.tiles) ? d.tiles : [],
    gatedPaths: Array.isArray(d.gatedPaths) ? d.gatedPaths : [],
    isOwner: d.isOwner === true,
    isAdmin: d.isAdmin === true,
    email: d.email ?? null,
  };
}

export function loadAccess(): Promise<Access> {
  if (!cache) {
    cache = fetchAccess().catch((e) => {
      // Deliberately do NOT cache the failure — a blip must not pin someone to
      // zero tiles for the rest of the session. The next caller retries.
      cache = null;
      throw e;
    });
  }
  return cache;
}

/** Force a refetch — used after the owner changes someone's grants. */
export function invalidateAccess(): void {
  cache = null;
}

/** `null` while loading: callers must render nothing sensitive until it resolves. */
export function useAccess(): Access | null {
  const [access, setAccess] = useState<Access | null>(null);
  useEffect(() => {
    let alive = true;
    loadAccess()
      .then((a) => alive && setAccess(a))
      .catch(() => alive && setAccess(DENY));
    return () => {
      alive = false;
    };
  }, []);
  return access;
}

/** Fire-and-forget usage log. */
export function logTileEvent(tile: string, kind: "open" = "open", detail?: string): void {
  void fetch(`${import.meta.env.BASE_URL}api/tile-open`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tile, kind, detail }),
  }).catch(() => {});
}
