import { useState } from "react";
import { useLocation, Link } from "wouter";
import { useRegister, getGetMeQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Loader2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

export default function Register() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const register = useRegister();
  
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
            title: "Registration failed",
            description: err instanceof Error ? err.message : "Could not create account",
            variant: "destructive",
          });
        },
      }
    );
  };

  return (
    <div className="min-h-[100dvh] w-full flex items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-sm shadow-lg border-border/50">
        <CardHeader className="space-y-1">
          <CardTitle className="text-2xl font-bold tracking-tight font-display">Create Account</CardTitle>
          <CardDescription>Register for KFI Dispatch access</CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit}>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="dispatcher@kfi.com"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
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
              {register.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create Account
            </Button>
            <div className="text-center text-sm">
              Already have an account?{" "}
              <Link href="/login" className="text-primary hover:underline underline-offset-4">
                Sign in
              </Link>
            </div>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
