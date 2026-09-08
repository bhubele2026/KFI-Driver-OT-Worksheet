import { Link } from "wouter";
import { Logo } from "@/components/logo";

/**
 * Say "you can't see this" instead of showing an empty table.
 *
 * The owner gate (`router.use("/admin", requireOwner)`) sits ABOVE each page's
 * own `requireAdmin`, so an admin who reaches one of these URLs renders the
 * whole page — heading, filters, Add form — and only the fetch 403s. None of
 * the pages read `isError`, so the result reads as "there is no data here"
 * rather than "this isn't yours". That is how a locked page looked like a
 * deleted feature (2026-09-08).
 */
export function OwnerOnlyNotice({ title }: { title: string }) {
  return (
    <div className="min-h-[100dvh] flex flex-col bg-background">
      <header className="sticky top-0 z-10 bg-sidebar text-sidebar-foreground border-b border-sidebar-border px-4 h-14 flex items-center gap-3 shadow-sm">
        <Link href="/" title="KFI Staffing" className="no-underline">
          <Logo />
        </Link>
        <div className="h-5 w-px bg-sidebar-border/60" />
        <span className="text-sm font-medium">{title}</span>
      </header>
      <main className="flex-1 grid place-items-center p-6">
        <div className="surface max-w-md rounded-card p-6 text-center ring-1 ring-brand-line">
          <h1 className="text-base font-semibold text-brand-navy">
            This page is the owner's
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {title} is part of Settings, which only the account owner can open.
            Nothing is missing and nothing is broken — you just can't see it
            from here.
          </p>
          <p className="mt-3 text-sm text-muted-foreground">
            If you came looking for a driver who imported onto the wrong person,
            or didn't import at all, that lives in{" "}
            <Link href="/mappings" className="font-medium text-brand-navy underline">
              Mappings
            </Link>
            .
          </p>
        </div>
      </main>
    </div>
  );
}
