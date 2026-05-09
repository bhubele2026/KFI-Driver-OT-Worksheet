import { Link, useLocation } from "wouter";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useGetMe } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, AlertTriangle, CheckCircle2 } from "lucide-react";
import { Logo } from "@/components/logo";
import { LanguageToggle } from "@/components/language-toggle";
import { getCoverageReport } from "@/i18n";

export default function AdminI18nStatus() {
  const { t } = useTranslation();
  const { data: me, isLoading } = useGetMe();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!isLoading && (!me || !me.isAdmin)) setLocation("/");
  }, [me, isLoading, setLocation]);

  if (isLoading || !me || !me.isAdmin) return null;

  const report = getCoverageReport();

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background">
      <header className="sticky top-0 z-10 bg-sidebar text-sidebar-foreground border-b border-sidebar-border px-4 h-14 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
          <Link href="/" className="no-underline"><Logo /></Link>
          <div className="h-5 w-px bg-sidebar-border/60" />
          <Link href="/">
            <Button variant="ghost" size="sm" className="h-8 text-sidebar-foreground hover:bg-sidebar-accent gap-2">
              <ArrowLeft className="h-4 w-4" />
              {t("adminCommon.back")}
            </Button>
          </Link>
        </div>
        <LanguageToggle />
      </header>
      <main className="flex-1 p-6 max-w-4xl mx-auto w-full space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold font-display tracking-tight">{t("adminI18n.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("adminI18n.description")}</p>
          <p className="text-xs text-muted-foreground font-mono">
            {t("adminI18n.summary", { total: report.totalKeys, locales: report.locales.length })}
          </p>
        </div>

        {report.missing.map((row) => (
          <Card key={row.locale} data-testid={`card-locale-${row.locale}`}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-3">
                <CardTitle className="text-lg flex items-center gap-2 font-mono uppercase">
                  {row.locale}
                  {row.keys.length === 0 && row.machineTranslated.length === 0 ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  ) : (
                    <AlertTriangle className="h-4 w-4 text-amber-500" />
                  )}
                </CardTitle>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="font-mono">
                    {row.keys.length} missing
                  </Badge>
                  <Badge variant="outline" className="font-mono">
                    {row.machineTranslated.length} machine
                  </Badge>
                </div>
              </div>
              <CardDescription>
                {row.keys.length === 0
                  ? t("adminI18n.noMissing")
                  : null}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {row.keys.length > 0 ? (
                <div>
                  <h3 className="text-sm font-semibold mb-2">{t("adminI18n.missingHeading")}</h3>
                  <ul
                    className="text-xs font-mono bg-muted/40 rounded-md p-3 space-y-1 max-h-72 overflow-auto"
                    data-testid={`list-missing-${row.locale}`}
                  >
                    {row.keys.map((k) => (
                      <li key={k} className="text-amber-700 dark:text-amber-300">
                        {k}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {row.machineTranslated.length > 0 ? (
                <div>
                  <h3 className="text-sm font-semibold mb-1">{t("adminI18n.machineHeading")}</h3>
                  <p className="text-xs text-muted-foreground mb-2">{t("adminI18n.machineDescription")}</p>
                  <ul
                    className="text-xs font-mono bg-muted/40 rounded-md p-3 space-y-1 max-h-72 overflow-auto"
                    data-testid={`list-machine-${row.locale}`}
                  >
                    {row.machineTranslated.map((k) => (
                      <li key={k} className="text-sky-700 dark:text-sky-300">{k}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </CardContent>
          </Card>
        ))}
      </main>
    </div>
  );
}
