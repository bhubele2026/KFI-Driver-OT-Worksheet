import { Switch, Route, Router as WouterRouter, Redirect, useLocation } from "wouter";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useGetMe, getGetMeQueryKey } from "@workspace/api-client-react";
import { Loader2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { setLanguage, type SupportedLocale } from "@/i18n";
import AdminI18nStatus from "@/pages/admin-i18n-status";
import NotFound from "@/pages/not-found";
import Login from "@/pages/login";
import Register from "@/pages/register";
import AcceptInvite from "@/pages/accept-invite";
import ForgotPassword from "@/pages/forgot-password";
import ResetPassword from "@/pages/reset-password";
import AdminUsers from "@/pages/admin-users";
import AdminAiSamples from "@/pages/admin-ai-samples";
import AdminCustomerAliases from "@/pages/admin-customer-aliases";
import AdminCustomers from "@/pages/admin-customers";
import AdminCustomerLessons from "@/pages/admin-customer-lessons";
import AdminInactiveCustomers from "@/pages/admin-inactive-customers";
import AdminDriverIdAliases from "@/pages/admin-driver-id-aliases";
import AdminDrivers from "@/pages/admin-drivers";
import AdminImportRules from "@/pages/admin-import-rules";
import AdminDriverCustomerOverrides from "@/pages/admin-driver-customer-overrides";
import AdminConnecteamUserAliases from "@/pages/admin-connecteam-user-aliases";
import AdminClockOffsets from "@/pages/admin-clock-offsets";
import AdminDeletedNotes from "@/pages/admin-deleted-notes";
import AdminBootAudit from "@/pages/admin-boot-audit";
import AdminRealtime from "@/pages/admin-realtime";
import AdminTimezones from "@/pages/admin-timezones";
import Home from "@/pages/home";
import { useAccess } from "@/lib/access";
import PayrollProcess from "@/pages/payroll-process";
import AdminAccess from "@/pages/admin-access";
import DriverUpload from "@/pages/driver-upload";
import History from "@/pages/history";
import Settings from "@/pages/settings";
import WeekSummary from "@/pages/week-summary";
import DriverDetail from "@/pages/driver-detail";
import { VersionRefreshBanner } from "@/components/version-refresh-banner";

// Defaults matter here: react-query's out-of-the-box staleTime is 0, so every
// click between drivers in the sidebar refetched the week, the roster and the
// punch list even though none of it had changed — that's the "loading" you
// feel moving around inside the app.
//
// A 30s stale window is only safe because invalidation is already thorough:
// ~33 modules call invalidateQueries on mutation, and use-live-updates.ts
// fires 27 of them off the SSE stream. Any real edit still busts its keys
// immediately, so hours are never shown stale after a change.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

function AuthGate({ children }: { children: React.ReactNode }) {
  const { data: user, isLoading } = useGetMe();
  const [location, setLocation] = useLocation();
  const access = useAccess();
  const { t } = useTranslation();

  useEffect(() => {
    if (user?.preferredLanguage) {
      const lng = (user.preferredLanguage === "es" ? "es" : "en") as SupportedLocale;
      setLanguage(lng);
    }
  }, [user?.preferredLanguage]);

  // Route gate. A tile you don't hold bounces to home and REWRITES the URL, so
  // the address can't simply be re-shared or re-pasted. Paths that aren't tiles
  // at all (driver detail, admin subpages) fall through untouched.
  const gated = access?.gatedPaths ?? [];
  const isGatedPath = gated.some((p) => location === p || location.startsWith(p + "/"));
  const held = (access?.tiles ?? []).some(
    (t) => location === t.href || location.startsWith(t.href + "/"),
  );
  const permitted = location === "/" || !isGatedPath || held;

  useEffect(() => {
    if (access && !permitted) setLocation("/");
  }, [access, permitted, setLocation]);

  if (isLoading || !access) {
    return (
      <div className="min-h-[100dvh] w-full flex flex-col items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary mb-4" />
        <p className="text-sm text-muted-foreground fin-num">{t("auth.initializing")}</p>
      </div>
    );
  }

  // Signed in through Microsoft, but this app has nothing for them yet.
  if (!user || access.tiles.length === 0) {
    return (
      <div className="min-h-[100dvh] w-full flex flex-col items-center justify-center gap-3 bg-background px-6 text-center">
        <h1 className="text-lg font-semibold text-brand-navy">No access yet</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          You're signed in{access.email ? ` as ${access.email}` : ""}, but nothing has been
          shared with you here yet. Ask Brad Hubele for access.
        </p>
      </div>
    );
  }

  if (!permitted) return null;

  return <>{children}</>;
}

function Router() {
  return (
    <AuthGate>
      <Switch>
        <Route path="/login" component={Login} />
        <Route path="/register" component={Register} />
        <Route path="/forgot-password" component={ForgotPassword} />
        <Route path="/reset-password/:token" component={ResetPassword} />
        <Route path="/accept-invite/:token" component={AcceptInvite} />
        <Route path="/admin/users" component={AdminUsers} />
        <Route path="/admin/ai-samples" component={AdminAiSamples} />
        <Route path="/admin/customer-aliases" component={AdminCustomerAliases} />
        <Route path="/admin/customers" component={AdminCustomers} />
        <Route
          path="/admin/customers/:id/lessons"
          component={AdminCustomerLessons}
        />
        <Route path="/admin/inactive-customers" component={AdminInactiveCustomers} />
        <Route path="/admin/drivers" component={AdminDrivers} />
        <Route path="/admin/customer-import-rules" component={AdminImportRules} />
        <Route path="/admin/driver-id-aliases" component={AdminDriverIdAliases} />
        <Route
          path="/admin/driver-customer-overrides"
          component={AdminDriverCustomerOverrides}
        />
        <Route
          path="/admin/connecteam-user-aliases"
          component={AdminConnecteamUserAliases}
        />
        <Route path="/admin/clock-offsets" component={AdminClockOffsets} />
        <Route path="/admin/notes" component={AdminDeletedNotes} />
        <Route path="/admin/boot-audit" component={AdminBootAudit} />
        <Route path="/admin/realtime" component={AdminRealtime} />
        <Route path="/admin/timezones" component={AdminTimezones} />
        <Route path="/admin/i18n" component={AdminI18nStatus} />
        <Route path="/" component={Home} />
        <Route path="/upload/:weekStart" component={DriverUpload} />
        <Route path="/upload" component={DriverUpload} />
        <Route path="/timesheets/:weekStart" component={WeekSummary} />
        <Route path="/timesheets" component={WeekSummary} />
        <Route path="/history" component={History} />
        <Route path="/settings" component={Settings} />
        <Route path="/payroll-process" component={PayrollProcess} />
        <Route path="/admin/access" component={AdminAccess} />
        {/* legacy paths still resolve to the worksheet */}
        <Route path="/worksheet" component={WeekSummary} />
        <Route path="/weeks/:weekStart" component={WeekSummary} />
        <Route path="/weeks/:weekStart/drivers/:kfiId" component={DriverDetail} />
        <Route component={NotFound} />
      </Switch>
    </AuthGate>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <VersionRefreshBanner />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
