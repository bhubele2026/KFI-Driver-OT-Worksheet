import { Switch, Route, Router as WouterRouter, Redirect, useLocation } from "wouter";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useGetMe, getGetMeQueryKey } from "@workspace/api-client-react";
import { Loader2 } from "lucide-react";
import { useEffect, useRef } from "react";
import NotFound from "@/pages/not-found";
import Login from "@/pages/login";
import Register from "@/pages/register";
import AcceptInvite from "@/pages/accept-invite";
import ForgotPassword from "@/pages/forgot-password";
import ResetPassword from "@/pages/reset-password";
import AdminUsers from "@/pages/admin-users";
import AdminAiSamples from "@/pages/admin-ai-samples";
import WeekSummary from "@/pages/week-summary";
import DriverDetail from "@/pages/driver-detail";

const queryClient = new QueryClient();

const DEV_BYPASS_AUTH = import.meta.env.DEV;

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

  if (isLoading || (DEV_BYPASS_AUTH && !user && triedBypass.current)) {
    return (
      <div className="min-h-[100dvh] w-full flex flex-col items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary mb-4" />
        <p className="text-sm text-muted-foreground font-mono">INITIALIZING_SESSION...</p>
      </div>
    );
  }

  const PUBLIC_ROUTE_RES = [
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
    return <Redirect to="/" />;
  }

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
        <Route path="/" component={WeekSummary} />
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
