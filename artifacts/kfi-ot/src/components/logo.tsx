import logoUrl from "@assets/image_1778108482721.png";
import { cn } from "@/lib/utils";

interface LogoProps {
  variant?: "header" | "auth";
  className?: string;
}

export function Logo({ variant = "header", className }: LogoProps) {
  if (variant === "auth") {
    return (
      <div
        className={cn(
          "mx-auto mb-6 w-full max-w-sm overflow-hidden rounded-md border border-border/40 shadow-sm",
          className,
        )}
      >
        <img
          src={logoUrl}
          alt="KFI Staffing"
          className="block w-full h-auto select-none"
          draggable={false}
        />
      </div>
    );
  }
  return (
    <img
      src={logoUrl}
      alt="KFI Staffing"
      draggable={false}
      className={cn("h-7 w-auto select-none shrink-0", className)}
    />
  );
}
