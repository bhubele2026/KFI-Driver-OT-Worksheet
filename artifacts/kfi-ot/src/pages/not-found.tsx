import { Link } from "wouter";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertCircle } from "lucide-react";
import { Logo } from "@/components/logo";

export default function NotFound() {
  return (
    <div className="min-h-[100dvh] w-full flex items-center justify-center bg-muted/30 p-4">
      <div className="w-full max-w-sm">
        <Logo variant="auth" />
        <Card className="shadow-lg border-border/50">
          <CardHeader className="space-y-1">
            <div className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-destructive" />
              <CardTitle className="text-2xl font-display tracking-tight">
                Page not found
              </CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              The page you're looking for doesn't exist or may have moved.
            </p>
          </CardContent>
          <CardFooter>
            <Link href="/">
              <Button variant="default">Back to dashboard</Button>
            </Link>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
