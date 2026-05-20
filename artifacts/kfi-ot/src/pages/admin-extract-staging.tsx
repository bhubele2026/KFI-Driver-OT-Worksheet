import { Link, Redirect } from "wouter";
import {
  useGetMe,
  useListExtractStaging,
  useDiscardExtractStaging,
  getListExtractStagingQueryKey,
  type ExtractStagingRow,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Loader2, Trash2, Upload } from "lucide-react";
import { format } from "date-fns";

const LIMIT = 200;

export default function AdminExtractStaging() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: me, isLoading: meLoading } = useGetMe();

  const { data, isLoading } = useListExtractStaging(
    { limit: LIMIT },
    {
      query: {
        enabled: !!me?.isAdmin,
        queryKey: getListExtractStagingQueryKey({ limit: LIMIT }),
      },
    },
  );

  const discard = useDiscardExtractStaging();

  if (!meLoading && me && !me.isAdmin) {
    return <Redirect to="/" />;
  }

  const rows: ExtractStagingRow[] = data ?? [];

  const handleDiscard = (r: ExtractStagingRow) => {
    const ok = window.confirm(
      `Discard ${r.chunksStaged}/${r.chunkCount} staged chunks for "${r.fileName}" (${r.customer} • ${r.weekStart})? This can't be undone.`,
    );
    if (!ok) return;
    discard.mutate(
      { uploadKey: r.uploadKey },
      {
        onSuccess: (res) => {
          qc.invalidateQueries({
            queryKey: getListExtractStagingQueryKey({ limit: LIMIT }),
          });
          toast({
            title: "Resumable upload discarded",
            description: `Cleared ${res.deleted} staged chunk${res.deleted === 1 ? "" : "s"} for ${r.fileName}.`,
          });
        },
        onError: (err) =>
          toast({
            title: "Couldn't discard upload",
            description: err instanceof Error ? err.message : "Unknown error",
            variant: "destructive",
          }),
      },
    );
  };

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background">
      <header className="sticky top-0 z-10 bg-sidebar text-sidebar-foreground border-b border-sidebar-border px-4 h-14 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
          <Link href="/admin/users">
            <Button
              variant="ghost"
              size="sm"
              className="text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground h-8"
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to users
            </Button>
          </Link>
          <h1 className="font-display font-bold text-lg tracking-tight">
            Resumable uploads
          </h1>
        </div>
      </header>

      <main className="flex-1 px-4 py-6 max-w-6xl w-full mx-auto space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="font-display text-base flex items-center gap-2">
              <Upload className="h-4 w-4" />
              In-flight AI-extract uploads
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground mb-4">
              Every customer-file upload that uses the AI extractor stages its
              chunks here so it can resume if the browser tab closes mid-run.
              Rows that linger here usually mean the dispatcher abandoned the
              upload. Discarding a row frees the staged chunks; the dispatcher
              can re-upload the file from scratch.
            </p>
            <div className="flex flex-wrap gap-2 mb-4 text-xs">
              <Badge variant="secondary" className="font-mono">
                {rows.length === LIMIT
                  ? `${rows.length}+ uploads in flight`
                  : `${rows.length} upload${rows.length === 1 ? "" : "s"} in flight`}
              </Badge>
            </div>

            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
            ) : rows.length === 0 ? (
              <p
                className="text-sm text-muted-foreground italic"
                data-testid="text-extract-staging-empty"
              >
                Nothing staged. All resumable uploads have either completed or
                been discarded.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[140px]">Customer</TableHead>
                    <TableHead className="w-[110px]">Week</TableHead>
                    <TableHead>File</TableHead>
                    <TableHead className="w-[120px]">Progress</TableHead>
                    <TableHead className="w-[170px]">Last touched</TableHead>
                    <TableHead className="w-[1%]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow
                      key={r.uploadKey}
                      data-testid={`row-extract-staging-${r.uploadKey}`}
                    >
                      <TableCell className="text-xs align-top">
                        {r.customer}
                      </TableCell>
                      <TableCell className="text-xs align-top whitespace-nowrap font-mono text-muted-foreground">
                        {r.weekStart}
                      </TableCell>
                      <TableCell className="text-sm align-top">
                        <p className="break-words max-w-[40ch]">{r.fileName}</p>
                        <div className="text-[10px] text-muted-foreground font-mono mt-0.5">
                          key {r.uploadKey}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs align-top whitespace-nowrap font-mono">
                        {r.chunksStaged}/{r.chunkCount}
                      </TableCell>
                      <TableCell className="text-xs align-top whitespace-nowrap font-mono text-muted-foreground">
                        {format(new Date(r.lastTouchedAt), "yyyy-MM-dd HH:mm")}
                        <div className="text-[10px] mt-0.5">
                          started{" "}
                          {format(new Date(r.createdAt), "yyyy-MM-dd HH:mm")}
                        </div>
                      </TableCell>
                      <TableCell className="align-top">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => handleDiscard(r)}
                          disabled={discard.isPending}
                          data-testid={`button-discard-staging-${r.uploadKey}`}
                        >
                          {discard.isPending &&
                          discard.variables?.uploadKey === r.uploadKey ? (
                            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                          ) : (
                            <Trash2 className="h-3 w-3 mr-1" />
                          )}
                          Discard
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
