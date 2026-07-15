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
import AdminDriverCustomerOverrides from "@/pages/admin-driver-customer-overrides";
import AdminConnecteamUserAliases from "@/pages/admin-connecteam-user-aliases";
import AdminClockOffsets from "@/pages/admin-clock-offsets";
import AdminDeletedNotes from "@/pages/admin-deleted-notes";
import AdminBootAudit from "@/pages/admin-boot-audit";
import AdminRealtime from "@/pages/admin-realtime";
import AdminTimezones from "@/pages/admin-timezones";
import Landing from "@/pages/landing";
import WeekSummary from "@/pages/week-summary";
import DriverDetail from "@/pages/driver-detail";
import { CopilotDrawer } from "@/components/copilot-drawer";

const queryClient = new QueryClient();

// Auto-call /api/auth/dev-bypass on load when:
//  - running in Vite dev mode, OR
//  - the build was made with VITE_PUBLIC_BYPASS_AUTH=1 (used to share the
//    published app publicly without login). Unset that env var (and rebuild)
//  to restore the normal login flow.
const DEV_BYPASS_AUTH =
  import.meta.env.DEV || import.meta.env.VITE_PUBLIC_BYPASS_AUTH === "1";

function AuthGate({ children }: { children: React.ReactNode }) {
  const { data: user, isLoading } = useGetMe();
  const [location] = useLocation();
  const qc = useQueryClient();
  const triedBypass = useRef(false);

  useEffect(() => {
    if (
      !DEV_BYPASS_AUTH ||
      isLoading ||
      user ||
      triedBypass.current
    ) {
      return;
    }
    triedBypass.current = true;
    void fetch(`${import.meta.env.BASE_URL}api/auth/dev-bypass`, {
      method: "POST",
      credentials: "include",
    }).then((r) => {
      if (r.ok) qc.invalidateQueries({ queryKey: getGetMeQueryKey() });
    });
  }, [user, isLoading, qc]);

  const { t } = useTranslation();
  useEffect(() => {
    if (user?.preferredLanguage) {
      const lng = (user.preferredLanguage === "es" ? "es" : "en") as SupportedLocale;
      setLanguage(lng);
    }
  }, [user?.preferredLanguage]);

  if (isLoading || (DEV_BYPASS_AUTH && !user && triedBypass.current)) {
    return (
      <div className="min-h-[100dvh] w-full flex flex-col items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary mb-4" />
        <p className="text-sm text-muted-foreground font-mono">{t("auth.initializing")}</p>
      </div>
    );
  }

  const PUBLIC_ROUTE_RES = [
    /^\/$/,
    /^\/login$/,
    /^\/register$/,
    /^\/forgot-password$/,
    /^\/reset-password\/.+$/,
    /^\/accept-invite\/.+$/,
  ];
  const isPublicRoute = PUBLIC_ROUTE_RES.some((re) => re.test(location));
  const isLoginRoute = location === "/login" || location === "/register";

  if (!user && !isPublicRoute) {
    return <Redirect to="/login" />;
  }

  if (user && isLoginRoute) {
    return <Redirect to="/worksheet" />;
  }

  return (
    <>
      {children}
      {user && <CopilotDrawer />}
    </>
  );
}

// Front door: logged-out visitors see the branded Landing page; authenticated
// users get the worksheet at "/" exactly as before (so every in-app link and
// logo href that points to "/" still lands on the worksheet).
function Home() {
  const { data: user, isLoading } = useGetMe();
  if (isLoading) return null;
  return user ? <WeekSummary /> : <Landing />;
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
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
