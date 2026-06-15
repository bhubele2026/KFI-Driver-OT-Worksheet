import { useState } from "react";
import { useLocation, Link } from "wouter";
import {
  useLogin,
  useGetRegistrationStatus,
  getGetMeQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Loader2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Logo } from "@/components/logo";
import { LanguageToggle } from "@/components/language-toggle";
import { useTranslation } from "react-i18next";

export default function Login() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const login = useLogin();
  const { data: regStatus } = useGetRegistrationStatus();
  const { t } = useTranslation();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    login.mutate(
      { data: { email, password } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
          setLocation("/");
        },
        onError: (err) => {
          toast({
            title: t("login.failedTitle"),
            description: err instanceof Error ? err.message : t("login.failedFallback"),
            variant: "destructive",
          });
        },
      }
    );
  };

  return (
    <div className="min-h-[100dvh] w-full flex items-center justify-center bg-muted p-4">
      <div className="w-full max-w-sm">
        <div className="flex justify-end mb-2">
          <LanguageToggle />
        </div>
        <Card className="overflow-hidden border-border shadow-lg">
        <div className="bg-sidebar flex items-center justify-center px-6 py-6">
          <Logo className="h-10" />
        </div>
        <CardHeader className="space-y-1">
          <CardTitle className="text-2xl font-bold tracking-tight font-display">{t("login.title")}</CardTitle>
          <CardDescription>{t("login.description")}</CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit}>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">{t("common.email")}</Label>
              <Input
                id="email"
                type="email"
                placeholder={t("login.emailPlaceholder")}
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">{t("common.password")}</Label>
              <Input
                id="password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </CardContent>
          <CardFooter className="flex flex-col space-y-4">
            <Button
              type="submit"
              className="w-full"
              disabled={login.isPending}
              data-testid="button-login-submit"
            >
              {login.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("login.submit")}
            </Button>
            <div className="text-center text-sm">
              <Link
                href="/forgot-password"
                className="text-primary hover:underline underline-offset-4"
              >
                {t("login.forgot")}
              </Link>
            </div>
            {regStatus?.openRegistration && (
              <div className="text-center text-sm text-muted-foreground">
                {t("login.firstTime")}{" "}
                <Link
                  href="/register"
                  className="text-primary hover:underline underline-offset-4"
                >
                  {t("login.createAdmin")}
                </Link>
              </div>
            )}
          </CardFooter>
        </form>
        </Card>
      </div>
    </div>
  );
}
