import { Link } from "wouter";
import { useGetMe } from "@workspace/api-client-react";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { LanguageToggle } from "@/components/language-toggle";
import {
  ArrowRight,
  Clock,
  FileSpreadsheet,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

const FEATURES = [
  {
    icon: Clock,
    title: "Connecteam sync",
    body: "Pull every driver's time-clock punches for the payroll week straight from Connecteam.",
  },
  {
    icon: FileSpreadsheet,
    title: "Customer timesheets",
    body: "Drop in each customer's spreadsheet, PDF, or photo — it's read automatically.",
  },
  {
    icon: Sparkles,
    title: "AI extraction",
    body: "Claude learns each customer's format once, then reuses it — no re-keying hours.",
  },
  {
    icon: ShieldCheck,
    title: "Reconciled & export-ready",
    body: "Regular/OT split, driver-vs-customer mismatch flags, and a Zenople payroll export.",
  },
];

export default function Landing() {
  const { data: user, isLoading } = useGetMe();
  const signedIn = Boolean(user);
  const ctaHref = signedIn ? "/worksheet" : "/login";
  const ctaLabel = signedIn ? "Open this week's worksheet" : "Sign in";

  return (
    <div className="min-h-[100dvh] w-full bg-background flex flex-col">
      {/* Navy hero */}
      <header className="bg-sidebar text-sidebar-foreground">
        <div className="mx-auto w-full max-w-5xl px-6">
          <div className="flex items-center justify-between py-4">
            <Logo variant="header" />
            <LanguageToggle tone="navy" />
          </div>
          <div className="max-w-2xl py-14 sm:py-20">
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-sidebar-primary">
              KFI Workforce Deployment
            </p>
            <h1 className="mt-3 font-display text-4xl font-bold leading-[1.05] sm:text-5xl">
              Driver OT Worksheet
            </h1>
            <p className="mt-4 max-w-xl text-base leading-relaxed text-sidebar-foreground/80">
              Reconcile driver time-clock punches against customer timesheets and
              produce payroll-ready hours every week — one place, no spreadsheets to
              wrangle.
            </p>
            <div className="mt-8">
              <Link href={ctaHref}>
                <Button
                  size="lg"
                  disabled={isLoading}
                  className="gap-2"
                  data-testid="landing-cta"
                >
                  {ctaLabel}
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </header>

      {/* Feature grid */}
      <main className="mx-auto w-full max-w-5xl px-6 py-12 sm:py-16">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="rounded-md border border-card-border bg-card p-5"
            >
              <f.icon className="h-5 w-5 text-primary" />
              <h2 className="mt-3 text-sm font-semibold text-foreground">
                {f.title}
              </h2>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                {f.body}
              </p>
            </div>
          ))}
        </div>
      </main>

      <footer className="mt-auto border-t border-border">
        <div className="mx-auto w-full max-w-5xl px-6 py-5 font-mono text-xs text-muted-foreground">
          KFI Workforce Deployment · internal payroll tool
        </div>
      </footer>
    </div>
  );
}
