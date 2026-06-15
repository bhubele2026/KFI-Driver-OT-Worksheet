import logoUrl from "@assets/kfi-workforce-deployment-logo.png";
import { cn } from "@/lib/utils";

interface LogoProps {
  variant?: "header" | "auth";
  className?: string;
}

export function Logo({ variant = "header", className }: LogoProps) {
  if (variant === "auth") {
    // Login / auth screens: the logo art ships on its own navy block, so
    // we show it full-width with sharp corners — no extra border chrome.
    return (
      <img
        src={logoUrl}
        alt="KFI Workforce Deployment"
        className={cn(
          "mx-auto mb-6 block w-full max-w-sm select-none rounded-sm",
          className,
        )}
        draggable={false}
      />
    );
  }
  // Header: sits on the navy app bar; the logo's own navy backdrop blends
  // into the bar so only the white mark reads.
  return (
    <img
      src={logoUrl}
      alt="KFI Workforce Deployment"
      draggable={false}
      className={cn("h-9 w-auto select-none shrink-0", className)}
    />
  );
}
