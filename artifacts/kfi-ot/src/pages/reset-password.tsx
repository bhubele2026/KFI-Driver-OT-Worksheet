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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      toast({ title: "Passwords don't match", variant: "destructive" });
      return;
    }
    reset.mutate(
      { data: { token, password } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
          toast({ title: "Password updated" });
          setLocation("/");
        },
        onError: (err) => {
          toast({
            title: "Reset failed",
            description:
              err instanceof Error ? err.message : "Try requesting a new link",
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
        <Card className="w-full max-w-sm shadow-lg border-border/50">
          <CardHeader>
            <CardTitle className="text-xl font-display">
              Reset link invalid
            </CardTitle>
            <CardDescription>
              This password reset link has expired, been used, or never existed.
            </CardDescription>
          </CardHeader>
          <CardFooter className="flex flex-col items-start space-y-2">
            <Link
              href="/forgot-password"
              className="text-sm text-primary hover:underline underline-offset-4"
            >
              Request a new reset link
            </Link>
            <Link
              href="/login"
              className="text-sm text-primary hover:underline underline-offset-4"
            >
              Back to sign in
            </Link>
          </CardFooter>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-sm shadow-lg border-border/50">
        <CardHeader>
          <CardTitle className="text-2xl font-bold font-display tracking-tight">
            Set new password
          </CardTitle>
          <CardDescription>
            Resetting password for{" "}
            <span className="font-mono text-foreground">{data.email}</span>.
          </CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit}>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="password">New password</Label>
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
              <Label htmlFor="confirm">Confirm password</Label>
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
              Update password
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
