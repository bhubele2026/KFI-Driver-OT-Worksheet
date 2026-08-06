import logoUrl from "@assets/kfi-workforce-deployment-logo.png";
// White mark on a TRANSPARENT background (alpha-matted off the original
// art's baked-in navy). The source PNG's navy (#172B51) never matched the
// app bar's (#19315b), so the logo read as a box on the navy — this is the
// same treatment the KFI Financial Dashboard uses (2026-08-05).
import logoWhiteUrl from "@assets/kfi-workforce-deployment-logo-white.png";
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
  // Header / hero: sits on navy. Transparent white mark — no backdrop, so
  // the navy runs continuously behind it at any shade.
  return (
    <img
      src={logoWhiteUrl}
      alt="KFI Workforce Deployment"
      draggable={false}
      className={cn("h-10 w-auto select-none shrink-0", className)}
    />
  );
}
