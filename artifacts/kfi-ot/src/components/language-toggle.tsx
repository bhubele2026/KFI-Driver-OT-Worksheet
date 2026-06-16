import { useTranslation } from "react-i18next";
import {
  useGetMe,
  useUpdateMyLanguage,
  getGetMeQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { setLanguage, type SupportedLocale } from "@/i18n";
import { cn } from "@/lib/utils";

export function LanguageToggle({
  className,
  tone = "navy",
}: {
  className?: string;
  // "navy" = on the navy header/sidebar (default); "light" = on a white/
  // light surface (e.g. the login page), where the navy-tuned sidebar tokens
  // render near-invisible. The rebrand (98c0e59) flipped sidebar-foreground to
  // near-white, which washed this control out on the login page.
  tone?: "navy" | "light";
}) {
  const { i18n, t } = useTranslation();
  const { data: me } = useGetMe();
  const update = useUpdateMyLanguage();
  const qc = useQueryClient();
  const { toast } = useToast();
  const current = (i18n.language?.startsWith("es") ? "es" : "en") as SupportedLocale;

  const choose = (lng: SupportedLocale) => {
    if (lng === current) return;
    setLanguage(lng);
    if (!me) return;
    update.mutate(
      { data: { preferredLanguage: lng } },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getGetMeQueryKey() });
          toast({
            title: t("toggle.savedTitle"),
            description: t("toggle.savedDescription"),
          });
        },
        onError: () => {
          // Keep the local change but tell the user persistence failed.
          toast({
            title: t("errors.saveFailed"),
            variant: "destructive",
          });
        },
      },
    );
  };

  const onLight = tone === "light";
  const btnCls = (active: boolean) =>
    cn(
      "h-6 px-2 rounded-sm text-xs font-mono",
      active
        ? onLight
          ? "bg-primary text-primary-foreground"
          : "bg-sidebar-accent text-sidebar-accent-foreground"
        : onLight
          ? "text-muted-foreground hover:text-foreground"
          : "text-sidebar-foreground/70 hover:text-sidebar-accent-foreground",
    );
  return (
    <div
      className={cn(
        "inline-flex items-center rounded-md border p-0.5 text-xs font-mono",
        onLight
          ? "border-border bg-background"
          : "border-sidebar-border/60 bg-sidebar-accent/30",
        className,
      )}
      role="group"
      aria-label={t("toggle.switchLanguage")}
      data-testid="language-toggle"
    >
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => choose("en")}
        aria-pressed={current === "en"}
        data-testid="language-toggle-en"
        className={btnCls(current === "en")}
      >
        EN
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => choose("es")}
        aria-pressed={current === "es"}
        data-testid="language-toggle-es"
        className={btnCls(current === "es")}
      >
        ES
      </Button>
    </div>
  );
}
