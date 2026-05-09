import { useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import {
  useGetPasswordReset,
  useResetPassword,
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

export default function ResetPassword() {
  const params = useParams<{ token: string }>();
  const token = params.token;
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useGetPasswordReset(token);
  const reset = useResetPassword();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const { t } = useTranslation();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      toast({ title: t("resetPassword.passwordsMismatch"), variant: "destructive" });
      return;
    }
    reset.mutate(
      { data: { token, password } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
          toast({ title: t("resetPassword.successTitle") });
          setLocation("/");
        },
        onError: (err) => {
          toast({
            title: t("resetPassword.failedTitle"),
            description:
              err instanceof Error ? err.message : t("resetPassword.failedFallback"),
            variant: "destructive",
          });
        },
      },
    );
  };

  if (isLoading) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-muted/30">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-muted/30 p-4">
        <div className="w-full max-w-sm">
          <div className="flex justify-end mb-2"><LanguageToggle /></div>
          <Logo variant="auth" />
          <Card className="shadow-lg border-border/50">
          <CardHeader>
            <CardTitle className="text-xl font-display">
              {t("resetPassword.invalidTitle")}
            </CardTitle>
            <CardDescription>
              {t("resetPassword.invalidDescription")}
            </CardDescription>
          </CardHeader>
          <CardFooter className="flex flex-col items-start space-y-2">
            <Link
              href="/forgot-password"
              className="text-sm text-primary hover:underline underline-offset-4"
            >
              {t("resetPassword.requestNew")}
            </Link>
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
    <div className="min-h-[100dvh] flex items-center justify-center bg-muted/30 p-4">
      <div className="w-full max-w-sm">
        <div className="flex justify-end mb-2"><LanguageToggle /></div>
        <Logo variant="auth" />
        <Card className="shadow-lg border-border/50">
        <CardHeader>
          <CardTitle className="text-2xl font-bold font-display tracking-tight">
            {t("resetPassword.title")}
          </CardTitle>
          <CardDescription>
            {t("resetPassword.description", { email: data.email })}
          </CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit}>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="password">{t("common.newPassword")}</Label>
              <Input
                id="password"
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm">{t("common.confirmPassword")}</Label>
              <Input
                id="confirm"
                type="password"
                required
                minLength={8}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>
          </CardContent>
          <CardFooter>
            <Button
              type="submit"
              className="w-full"
              disabled={reset.isPending}
            >
              {reset.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {t("resetPassword.submit")}
            </Button>
          </CardFooter>
        </form>
        </Card>
      </div>
    </div>
  );
}
