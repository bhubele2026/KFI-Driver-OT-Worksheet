import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useGetMe, useLogout, getGetMeQueryKey } from "@workspace/api-client-react";
import { LogOut } from "lucide-react";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { useAccess } from "@/lib/access";
import { GearButton } from "@/components/gear-button";

// The nav is driven by GET /api/tiles (same source as the home grid), so a
// tile the owner switched off disappears from BOTH without a second list to
// keep in sync.
/**
 * The one navy app bar for every signed-in page — logo, section nav, language,
 * and sign-out. Replaces the header that was hand-copied across the worksheet,
 * driver detail, and every admin page. Page content goes in `children`; pages
 * render their own sub-toolbar (week selector, actions) at the top of it.
 */
export function AppShell({
  children,
  active,
  wide,
}: {
  children: ReactNode;
  /** Force which nav item is highlighted (defaults to the current path). */
  active?: string;
  /** Full-bleed content (no max-width / padding) — used by the tile home. */
  wide?: boolean;
}) {
  const { data: user } = useGetMe();
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const logout = useLogout();

  const access = useAccess();
  // No board-to-board links in the chrome — boards are chosen on the landing
  // ("once you are in the tile, that is it", the estate's standing law;
  // Brad on this app, 2026-09-01: "dont need links to others"). The wordmark
  // is the one way back. `active` is accepted and ignored so the twenty
  // pages that pass it did not need touching.
  void active;

  const handleLogout = () =>
    logout.mutate(undefined, {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetMeQueryKey() });
        setLocation("/login");
      },
    });

  return (
    <div className="min-h-[100dvh] bg-background">
      <header className="sticky top-0 z-30 bg-gradient-to-b from-brand-navy2 to-brand-navy text-white shadow-[inset_0_-1px_0_rgba(255,255,255,0.08),0_1px_2px_rgba(16,24,40,0.10)]">
        <div className="mx-auto flex h-14 w-full max-w-[1700px] items-center gap-5 px-5">
          <Link href="/" className="flex shrink-0 items-center no-underline" title="Home">
            <Logo variant="header" />
          </Link>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {user?.email && (
              <span className="hidden text-xs text-white/60 lg:inline">{user.email}</span>
            )}
            {access?.isOwner && <GearButton className="h-8 w-8" />}
            <Button
              variant="ghost"
              size="sm"
              onClick={handleLogout}
              className="h-8 gap-1.5 text-white/80 hover:bg-white/10 hover:text-white"
            >
              <LogOut className="h-4 w-4" />
              <span className="hidden sm:inline">Sign Out</span>
            </Button>
          </div>
        </div>
      </header>
      {wide ? (
        children
      ) : (
        <main className="mx-auto w-full max-w-[1700px] px-5 py-6">{children}</main>
      )}
    </div>
  );
}
