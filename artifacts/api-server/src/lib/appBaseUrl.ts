// Resolves the public origin used to build links (invite, reset, digest, …).
// Derived from server config only — never request headers — to defend against
// host-header poisoning.
export function appBaseUrl(): string | null {
  const explicit = process.env.APP_BASE_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  const replitDomains = process.env.REPLIT_DOMAINS;
  if (replitDomains) {
    const first = replitDomains.split(",")[0].trim();
    if (first) return `https://${first}`;
  }
  return null;
}
