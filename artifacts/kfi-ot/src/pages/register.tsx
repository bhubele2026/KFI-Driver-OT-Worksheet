import { useState } from "react";
import { useLocation, Link } from "wouter";
import {
  useRegister,
  useGetRegistrationStatus,
  getGetMeQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Loader2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Logo } from "@/components/logo";
import { LanguageToggle } from "@/components/language-toggle";
import { useTranslation } from "react-i18next";

export default function Register() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const register = useRegister();
  const { data: status, isLoading } = useGetRegistrationStatus();
  const { t } = useTranslation();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    register.mutate(
      { data: { email, password } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
          setLocation("/");
        },
        onError: (err) => {
          toast({
            title: t("register.failedTitle"),
            description:
              err instanceof Error
                ? err.message
                : t("register.failedFallback"),
            variant: "destructive",
          });
        },
      },
    );
  };

  if (isLoading) {
    return (
      <div className="min-h-[100dvh] w-full flex items-center justify-center bg-muted/30">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (!status?.openRegistration) {
    return (
      <div className="min-h-[100dvh] w-full flex items-center justify-center bg-muted/30 p-4">
        <div className="w-full max-w-sm">
          <div className="flex justify-end mb-2"><LanguageToggle /></div>
          <Logo variant="auth" />
          <Card className="shadow-lg border-border/50">
            <CardHeader className="space-y-1">
              <CardTitle className="text-2xl font-bold tracking-tight font-display">
                {t("register.inviteRequiredTitle")}
              </CardTitle>
              <CardDescription>
                {t("register.inviteRequiredDescription")}
              </CardDescription>
            </CardHeader>
            <CardFooter>
              <Link
                href="/login"
                className="text-sm text-primary hover:underline underline-offset-4"
              >
                {t("common.backToSignIn")}
              </Link>
            </CardFooter>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] w-full flex items-center justify-center bg-muted/30 p-4">
      <div className="w-full max-w-sm">
        <div className="flex justify-end mb-2"><LanguageToggle /></div>
        <Logo variant="auth" />
        <Card className="shadow-lg border-border/50">
        <CardHeader className="space-y-1">
          <CardTitle className="text-2xl font-bold tracking-tight font-display">
            {t("register.title")}
          </CardTitle>
          <CardDescription>
            {t("register.description")}
          </CardDescription>
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
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </CardContent>
          <CardFooter className="flex flex-col space-y-4">
            <Button
              type="submit"
              className="w-full"
              disabled={register.isPending}
            >
              {register.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {t("register.submit")}
            </Button>
            <div className="text-center text-sm">
              {t("register.alreadyHaveAccount")}{" "}
              <Link
                href="/login"
                className="text-primary hover:underline underline-offset-4"
              >
                {t("common.signIn")}
              </Link>
            </div>
          </CardFooter>
        </form>
        </Card>
      </div>
    </div>
  );
}
