import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useGetMe, useLogout, getGetMeQueryKey } from "@workspace/api-client-react";
import { LogOut } from "lucide-react";
import { Logo } from "@/components/logo";
import { LanguageToggle } from "@/components/language-toggle";
import { Button } from "@/components/ui/button";

interface Tile {
  href: string;
  title: string;
  blurb: string;
  source: string;
  adminOnly?: boolean;
}

const TILES: Tile[] = [
  {
    href: "/upload",
    title: "Driver Upload",
    blurb: "Refresh Connecteam punches and drop in each customer's timesheet for the week.",
    source: "Bring the week in",
  },
  {
    href: "/timesheets",
    title: "Timesheets",
    blurb: "Review hours and overtime, catch driver-vs-customer mismatches, print and export to Zenople.",
    source: "Review & export",
  },
  {
    href: "/history",
    title: "History",
    blurb: "Open any past payroll week to review or reprint what was already run.",
    source: "Past weeks",
  },
  {
    href: "/settings",
    title: "Settings",
    blurb: "Users, customers, driver aliases, clock offsets, timezones, and app configuration.",
    source: "Admin & config",
    adminOnly: true,
  },
];

export default function Home() {
  const [, setLocation] = useLocation();
  const { data: user } = useGetMe();
  const qc = useQueryClient();
  const logout = useLogout();

  const tiles = TILES.filter((t) => !t.adminOnly || user?.isAdmin);

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
      <div className="bg-brand-navy shadow-sm">
        <div className="mx-auto flex w-full max-w-[1700px] items-center justify-between gap-4 px-6 py-5 sm:py-6">
          <div>
            <Logo variant="header" className="h-8 sm:h-10" />
            <p className="mt-2.5 text-base font-medium text-white">
              Driver OT Worksheet
              <span className="ml-2 text-sm font-normal text-white/50">
                Reconcile the week. Run payroll clean.
              </span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            <LanguageToggle tone="navy" />
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
              key={tile.href}
              type="button"
              onClick={() => setLocation(tile.href)}
              style={{ animationDelay: `${i * 28}ms` }}
              className="tile-in group flex h-full flex-col rounded-2xl bg-white p-6 text-left shadow-md ring-1 ring-brand-line transition-all duration-150 ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-1 hover:shadow-xl hover:ring-brand-navy/25"
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
    </div>
  );
}
