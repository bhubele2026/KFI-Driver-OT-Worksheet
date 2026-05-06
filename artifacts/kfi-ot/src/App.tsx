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

  const isAuthRoute = location === "/login" || location === "/register";

  if (!user && !isAuthRoute) {
    return <Redirect to="/login" />;
  }

  if (user && isAuthRoute) {
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
