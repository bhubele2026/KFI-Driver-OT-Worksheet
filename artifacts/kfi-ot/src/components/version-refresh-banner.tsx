import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";

const POLL_MS = 5 * 60 * 1000;

/**
 * Shows a fixed "new version — refresh" bar when the server's build tag
 * (GET /api/app-version) stops matching the tag baked into this bundle.
 * Checks every 5 minutes and whenever the tab regains focus — the moment a
 * deploy lands, open tabs get nudged instead of silently running stale code.
 */
export function VersionRefreshBanner() {
  const { t } = useTranslation();
  const [stale, setStale] = useState(false);
  const mine = import.meta.env.VITE_APP_VERSION;

  useEffect(() => {
    if (!mine) return;
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch(`${import.meta.env.BASE_URL}api/app-version`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const json = (await res.json()) as { version?: string | null };
        if (!cancelled && json.version && json.version !== mine) setStale(true);
      } catch {
        // Offline / transient — try again next tick.
      }
    };
    void check();
    const interval = setInterval(check, POLL_MS);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [mine]);

  if (!stale) return null;
  return (
    <div
      className="fixed inset-x-0 top-0 z-[100] flex items-center justify-center gap-3 bg-brand-navy px-4 py-2 text-sm text-white shadow-md"
      data-testid="banner-version-refresh"
    >
      <span>{t("versionRefresh.message")}</span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="inline-flex items-center gap-1.5 rounded-md bg-white/15 px-3 py-1 text-xs font-semibold uppercase tracking-wide hover:bg-white/25 transition-colors"
        data-testid="button-version-refresh"
      >
        <RefreshCw className="h-3.5 w-3.5" />
        {t("versionRefresh.action")}
      </button>
    </div>
  );
}
