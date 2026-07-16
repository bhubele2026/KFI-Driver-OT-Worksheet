import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useGetMe, useLogout, getGetMeQueryKey } from "@workspace/api-client-react";
import { LogOut } from "lucide-react";
import { Logo } from "@/components/logo";
import { LanguageToggle } from "@/components/language-toggle";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface NavItem {
  href: string;
  label: string;
  adminOnly?: boolean;
}

const NAV: NavItem[] = [
  { href: "/upload", label: "Driver Upload" },
  { href: "/timesheets", label: "Timesheets" },
  { href: "/history", label: "History" },
  { href: "/settings", label: "Settings", adminOnly: true },
];

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
  const [location, setLocation] = useLocation();
  const qc = useQueryClient();
  const logout = useLogout();

  const items = NAV.filter((n) => !n.adminOnly || user?.isAdmin);
  const isActive = (href: string) =>
    active ? active === href : location === href || location.startsWith(href + "/");

  const handleLogout = () =>
    logout.mutate(undefined, {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetMeQueryKey() });
        setLocation("/login");
      },
    });

  return (
    <div className="min-h-[100dvh] bg-background">
      <header className="sticky top-0 z-30 bg-brand-navy text-white shadow-sm">
        <div className="mx-auto flex h-14 w-full max-w-[1700px] items-center gap-5 px-5">
          <Link href="/" className="flex shrink-0 items-center no-underline" title="Home">
            <Logo variant="header" />
          </Link>
          <nav className="flex items-center gap-1">
            {items.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  isActive(n.href)
                    ? "bg-white/15 text-white"
                    : "text-white/70 hover:bg-white/10 hover:text-white",
                )}
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <LanguageToggle tone="navy" />
            {user?.email && (
              <span className="hidden text-xs text-white/60 lg:inline">{user.email}</span>
            )}
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
