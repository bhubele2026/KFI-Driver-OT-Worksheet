import { Link, Redirect } from "wouter";
import { AppShell } from "@/components/app-shell";
import { useGetMe } from "@workspace/api-client-react";

interface MappingTile {
  href: string;
  title: string;
  blurb: string;
}

/**
 * The dispatcher's matching tools.
 *
 * Settings stays owner-only (Brad, 2026-09-01: "a gear on the top right that
 * only I can get to"). But the tables that decide WHICH DRIVER a name on a
 * customer's timesheet belongs to are not settings — they are the daily work
 * of running payroll, and locking them away meant a mis-matched driver could
 * only be fixed by the owner. This hub gives those six back to admins, and
 * nothing else.
 */
const TILES: MappingTile[] = [
  {
    href: "/admin/customer-aliases",
    title: "Customer-driver mappings",
    blurb:
      "A name as it appears on a customer's timesheet, and the KFI driver it means. Re-map a row when an import picked the wrong person.",
  },
  {
    href: "/admin/driver-id-aliases",
    title: "Badge & ID mappings",
    blurb:
      "A customer's badge or employee number pinned to a KFI driver. The most durable match there is — it survives nicknames and name changes.",
  },
  {
    href: "/admin/customer-import-rules",
    title: "Import rules",
    blurb:
      "How to read one customer's file: which sheet, how names are laid out, actual-vs-scheduled times, which total rows to drop.",
  },
  {
    href: "/admin/connecteam-user-aliases",
    title: "Connecteam mappings",
    blurb: "Connecteam users that need pointing at the right KFI driver.",
  },
  {
    href: "/admin/driver-customer-overrides",
    title: "Driver ↔ customer overrides",
    blurb: "Force a driver onto a customer when the roster disagrees.",
  },
  {
    href: "/admin/clock-offsets",
    title: "Clock offsets",
    blurb: "Per-clock corrections for a time clock whose raw timestamps run early or late.",
  },
];

export default function Mappings() {
  const { data: me, isLoading: meLoading } = useGetMe();

  if (!meLoading && me && !me.isAdmin) {
    return <Redirect to="/" />;
  }

  return (
    <AppShell active="/mappings">
      <div className="rise-in stagger space-y-7">
        <div>
          <h1 className="text-xl font-semibold text-brand-navy">Mappings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            When an import puts hours on the wrong person — or misses someone
            entirely — this is where you fix it.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {TILES.map((tile) => (
            <Link
              key={tile.href}
              href={tile.href}
              className="surface surface-lift press group flex flex-col rounded-card p-5 no-underline ring-1 ring-brand-line hover:-translate-y-0.5 hover:ring-brand-navy/25"
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
    </AppShell>
  );
}
