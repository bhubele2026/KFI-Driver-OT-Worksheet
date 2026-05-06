function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const v = Number(p);
    if (v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/**
 * True if `ip` matches a blocklist `entry`. Supports IPv4 single addresses and
 * IPv4 CIDR ranges. IPv6 falls back to exact-string match — good enough to
 * dedupe the "already blocked" badge in the admin UI.
 */
export function ipMatchesEntry(ip: string, entry: string): boolean {
  if (ip === entry) return true;
  const slash = entry.indexOf("/");
  if (slash === -1) return false;
  const net = entry.slice(0, slash);
  const pfxStr = entry.slice(slash + 1);
  if (!/^\d+$/.test(pfxStr)) return false;
  const pfx = Number(pfxStr);
  const ipInt = ipv4ToInt(ip);
  const netInt = ipv4ToInt(net);
  if (ipInt === null || netInt === null) return false;
  if (pfx < 0 || pfx > 32) return false;
  if (pfx === 0) return true;
  const mask = (0xffffffff << (32 - pfx)) >>> 0;
  return (ipInt & mask) === (netInt & mask);
}

export function ipMatchesAny(ip: string, entries: string[]): boolean {
  for (const e of entries) {
    if (ipMatchesEntry(ip, e)) return true;
  }
  return false;
}

export function isCidrEntry(entry: string): boolean {
  return entry.includes("/");
}
