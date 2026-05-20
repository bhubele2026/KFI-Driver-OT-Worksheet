import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw } from "lucide-react";

interface ClientRow {
  id: string;
  userId: number;
  email: string;
  weekStart: string;
  kfiId: string | null;
  connectedAgoMs: number;
}
interface PresenceRow {
  userId: number;
  email: string;
  weekStart: string;
  kfiId: string | null;
  lastSeenAgoMs: number;
}
interface EditingRow {
  weekStart: string;
  kfiId: string;
  punchId: number | null;
  userId: number;
  email: string;
  expiresInMs: number;
}
interface Snapshot {
  clientCount: number;
  presenceCount: number;
  editingCount: number;
  clients: ClientRow[];
  presence: PresenceRow[];
  editing: EditingRow[];
}

function ago(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

export default function AdminRealtime() {
  const { t } = useTranslation();
  const [data, setData] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const r = await fetch(`${import.meta.env.BASE_URL}api/admin/realtime`, {
        credentials: "include",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData((await r.json()) as Snapshot);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="container max-w-5xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-heading">{t("adminRealtime.title")}</h1>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void refresh()}
          disabled={loading}
          data-testid="button-refresh"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          <span className="ml-2">{t("adminRealtime.refresh")}</span>
        </Button>
      </div>
      {err && (
        <Card>
          <CardContent className="py-4 text-sm text-destructive font-mono">
            {err}
          </CardContent>
        </Card>
      )}
      {data && (
        <>
          <div className="grid grid-cols-3 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">{t("adminRealtime.sseClients")}</CardTitle>
              </CardHeader>
              <CardContent className="font-mono text-2xl">
                {data.clientCount}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">{t("adminRealtime.activeViewers")}</CardTitle>
              </CardHeader>
              <CardContent className="font-mono text-2xl">
                {data.presenceCount}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">{t("adminRealtime.editingLocks")}</CardTitle>
              </CardHeader>
              <CardContent className="font-mono text-2xl">
                {data.editingCount}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("adminRealtime.clients")}</CardTitle>
            </CardHeader>
            <CardContent>
              {data.clients.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("adminRealtime.noClients")}</p>
              ) : (
                <table className="w-full text-xs font-mono">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="py-1">{t("adminRealtime.email")}</th>
                      <th>{t("adminRealtime.week")}</th>
                      <th>{t("adminRealtime.driver")}</th>
                      <th className="text-right">{t("adminRealtime.connected")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.clients.map((c) => (
                      <tr key={c.id} className="border-t border-border">
                        <td className="py-1">{c.email}</td>
                        <td>{c.weekStart}</td>
                        <td>{c.kfiId ?? "—"}</td>
                        <td className="text-right">{t("adminRealtime.ago", { when: ago(c.connectedAgoMs) })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("adminRealtime.editing")}</CardTitle>
            </CardHeader>
            <CardContent>
              {data.editing.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("adminRealtime.noEditing")}</p>
              ) : (
                <table className="w-full text-xs font-mono">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="py-1">{t("adminRealtime.email")}</th>
                      <th>{t("adminRealtime.week")}</th>
                      <th>{t("adminRealtime.driver")}</th>
                      <th>{t("adminRealtime.punch")}</th>
                      <th className="text-right">{t("adminRealtime.expires")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.editing.map((e, i) => (
                      <tr key={i} className="border-t border-border">
                        <td className="py-1">{e.email}</td>
                        <td>{e.weekStart}</td>
                        <td>{e.kfiId}</td>
                        <td>{e.punchId ?? "row"}</td>
                        <td className="text-right">{t("adminRealtime.inTime", { when: ago(Math.max(0, e.expiresInMs)) })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
