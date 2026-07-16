import { Link, useLocation } from "wouter";
import { useEffect } from "react";
import { useGetMe } from "@workspace/api-client-react";
import { AppShell } from "@/components/app-shell";

interface SettingTile {
  href: string;
  title: string;
  blurb: string;
}

const GROUPS: { label: string; tiles: SettingTile[] }[] = [
  {
    label: "People & access",
    tiles: [
      { href: "/admin/users", title: "Users", blurb: "Accounts, roles, and invites." },
    ],
  },
  {
    label: "Customers",
    tiles: [
      { href: "/admin/customers", title: "Customers", blurb: "Active customers, filename keywords, and Gemini fallback." },
      { href: "/admin/customer-aliases", title: "Customer aliases", blurb: "Alternate names that map to a customer." },
      { href: "/admin/inactive-customers", title: "Inactive customers", blurb: "Archived customers kept for history." },
    ],
  },
  {
    label: "Drivers & matching",
    tiles: [
      { href: "/admin/drivers", title: "Drivers", blurb: "Turn someone off when they're no longer a driver, or reactivate them." },
      { href: "/admin/driver-id-aliases", title: "Driver ID aliases", blurb: "Customer badge / employee IDs that map to a KFI driver." },
      { href: "/admin/driver-customer-overrides", title: "Driver ↔ customer overrides", blurb: "Force a driver onto a customer." },
      { href: "/admin/connecteam-user-aliases", title: "Connecteam aliases", blurb: "Map Connecteam users to KFI drivers." },
      { href: "/admin/clock-offsets", title: "Clock offsets", blurb: "Per-clock raw-timestamp corrections." },
    ],
  },
  {
    label: "System",
    tiles: [
      { href: "/admin/timezones", title: "Timezones", blurb: "Per-customer display timezone preferences." },
      { href: "/admin/notes", title: "Deleted notes", blurb: "Recover notes removed from drivers." },
      { href: "/admin/boot-audit", title: "Boot audit", blurb: "Startup data-mutation audit log." },
      { href: "/admin/realtime", title: "Realtime", blurb: "Live presence and connection status." },
      { href: "/admin/ai-samples", title: "AI samples", blurb: "Captured extraction samples with TTL." },
      { href: "/admin/i18n", title: "Translations", blurb: "EN/ES translation coverage status." },
    ],
  },
];

export default function Settings() {
  const { data: user, isLoading } = useGetMe();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!isLoading && user && !user.isAdmin) setLocation("/");
  }, [isLoading, user, setLocation]);

  return (
    <AppShell active="/settings">
      <div className="space-y-7">
        <div>
          <h1 className="text-xl font-semibold text-brand-navy">Settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Users, customers, driver matching, and app configuration.
          </p>
        </div>

        {GROUPS.map((group) => (
          <div key={group.label} className="space-y-3">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
              {group.label}
            </h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {group.tiles.map((tile) => (
                <Link
                  key={tile.href}
                  href={tile.href}
                  className="group flex flex-col rounded-2xl bg-white p-5 no-underline shadow-sm ring-1 ring-border transition-all duration-150 ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-md hover:ring-brand-navy/25"
                >
                  <span className="text-sm font-semibold text-brand-navy">{tile.title}</span>
                  <span className="mt-1 text-sm text-muted-foreground">{tile.blurb}</span>
                  <span className="mt-auto inline-flex items-center gap-1.5 pt-4 text-[11px] font-medium uppercase tracking-wide text-neutral-400 transition-colors group-hover:text-brand-orange">
                    Open
                    <span aria-hidden className="transition-transform group-hover:translate-x-1">→</span>
                  </span>
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>
    </AppShell>
  );
}
