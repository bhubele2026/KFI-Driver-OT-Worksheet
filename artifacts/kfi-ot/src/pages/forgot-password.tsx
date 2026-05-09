import { useState } from "react";
import { Link } from "wouter";
import { useRequestPasswordReset } from "@workspace/api-client-react";
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
import { Loader2 } from "lucide-react";
import { Logo } from "@/components/logo";
import { LanguageToggle } from "@/components/language-toggle";
import { useTranslation } from "react-i18next";

export default function ForgotPassword() {
  const request = useRequestPasswordReset();
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const { t } = useTranslation();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    request.mutate(
      { data: { email } },
      {
        onSuccess: () => {
          setSubmitted(true);
        },
      },
    );
  };

  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-muted/30 p-4">
      <div className="w-full max-w-sm">
        <div className="flex justify-end mb-2"><LanguageToggle /></div>
        <Logo variant="auth" />
        <Card className="shadow-lg border-border/50">
        <CardHeader>
          <CardTitle className="text-2xl font-bold font-display tracking-tight">
            {t("forgotPassword.title")}
          </CardTitle>
          <CardDescription>
            {t("forgotPassword.description")}
          </CardDescription>
        </CardHeader>
        {submitted ? (
          <>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {t("forgotPassword.submittedBody", { email })}
              </p>
            </CardContent>
            <CardFooter>
              <Link
                href="/login"
                className="text-sm text-primary hover:underline underline-offset-4"
              >
                {t("common.backToSignIn")}
              </Link>
            </CardFooter>
          </>
        ) : (
          <form onSubmit={handleSubmit}>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">{t("common.email")}</Label>
                <Input
                  id="email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
            </CardContent>
            <CardFooter className="flex flex-col space-y-4">
              <Button
                type="submit"
                className="w-full"
                disabled={request.isPending}
              >
                {request.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                {t("forgotPassword.submit")}
              </Button>
              <Link
                href="/login"
                className="text-sm text-primary hover:underline underline-offset-4"
              >
                {t("common.backToSignIn")}
              </Link>
            </CardFooter>
          </form>
        )}
        </Card>
      </div>
    </div>
  );
}
