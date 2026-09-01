import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useGetMe, useLogout, getGetMeQueryKey } from "@workspace/api-client-react";
import { LogOut } from "lucide-react";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { useAccess } from "@/lib/access";
import { GearButton } from "@/components/gear-button";

/**
 * The tile list is NOT hardcoded here any more. It comes from GET /api/tiles,
 * which returns only the tiles this person holds — so the grid and the owner's
 * access panel cannot disagree, and a hidden tile never renders its shell.
 */
export default function Home() {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const logout = useLogout();
  const access = useAccess();
  const tiles = access?.tiles ?? [];

  const handleLogout = () =>
    logout.mutate(undefined, {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetMeQueryKey() });
        setLocation("/login");
      },
    });

  return (
    <div className="min-h-[100dvh] bg-background">
      {/* Navy brand hero — full-bleed, flush to edges */}
      <div className="bg-gradient-to-b from-brand-navy2 to-brand-navy shadow-[inset_0_-1px_0_rgba(255,255,255,0.08),0_1px_2px_rgba(16,24,40,0.10)]">
        <div className="mx-auto flex w-full max-w-[1700px] items-center justify-between gap-4 px-6 py-5 sm:py-6">
          <div>
            <Logo variant="header" className="h-14 sm:h-16" />
            <p className="mt-2.5 text-base font-medium text-white">
              KFI Payroll Processing
              <span className="ml-2 text-sm font-normal text-white/50">
                Reconcile the week. Run payroll clean.
              </span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            {access?.isOwner && <GearButton />}
            <Button
              variant="ghost"
              size="sm"
              onClick={handleLogout}
              className="h-9 gap-1.5 text-white/80 hover:bg-white/10 hover:text-white"
            >
              <LogOut className="h-4 w-4" />
              <span className="hidden sm:inline">Sign Out</span>
            </Button>
          </div>
        </div>
      </div>

      {/* Tile grid */}
      <div className="mx-auto w-full max-w-[1700px] px-6 py-8">
        <div className="grid grid-cols-1 items-stretch gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {tiles.map((tile, i) => (
            <button
              key={tile.key}
              type="button"
              /* The open is logged by the route-change effect in App.tsx (so
                 deep links count identically); the press itself reaches the
                 Activity feed through the click log. */
              onClick={() => setLocation(tile.href)}
              style={{ animationDelay: `calc(${i} * var(--stagger))` }}
              className="tile-in card-bleed surface surface-lift press group relative flex h-full flex-col overflow-hidden rounded-card p-6 text-left ring-1 ring-brand-line hover:-translate-y-1 hover:ring-brand-navy/25"
            >
              <span className="text-base font-semibold text-brand-navy">{tile.title}</span>
              <span className="mt-1.5 text-sm text-neutral-500">{tile.blurb}</span>
              <span className="mt-auto inline-flex items-center gap-1.5 pt-5 text-[11px] font-medium uppercase tracking-wide text-neutral-400 transition-colors duration-300 group-hover:text-brand-orange">
                {tile.source}
                <span aria-hidden className="transition-transform duration-300 group-hover:translate-x-1">
                  →
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
      {import.meta.env.VITE_APP_VERSION ? (
        <span
          className="fixed bottom-2 left-3 z-10 text-[11px] text-neutral-400 fin-num"
          title={`Build ${import.meta.env.VITE_APP_VERSION}`}
          data-testid="text-app-version"
        >
          {import.meta.env.VITE_APP_VERSION}
        </span>
      ) : null}
    </div>
  );
}
