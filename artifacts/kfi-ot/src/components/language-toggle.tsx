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

export function LanguageToggle({ className }: { className?: string }) {
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

  return (
    <div
      className={cn(
        "inline-flex items-center rounded-md border border-sidebar-border/60 bg-sidebar-accent/30 p-0.5 text-xs font-mono",
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
        className={cn(
          "h-6 px-2 rounded-sm text-xs font-mono",
          current === "en"
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "text-sidebar-foreground/70 hover:text-sidebar-accent-foreground",
        )}
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
        className={cn(
          "h-6 px-2 rounded-sm text-xs font-mono",
          current === "es"
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "text-sidebar-foreground/70 hover:text-sidebar-accent-foreground",
        )}
      >
        ES
      </Button>
    </div>
  );
}
