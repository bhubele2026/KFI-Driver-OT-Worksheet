import { Link, Redirect } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetMe,
  useListDeletedDriverNotes,
  useRestoreDriverNote,
  getListDeletedDriverNotesQueryKey,
  getListDriverNotesQueryKey,
  type DeletedDriverNote,
} from "@workspace/api-client-react";
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
import { ArrowLeft, EyeOff, Loader2, Undo2 } from "lucide-react";
import { format } from "date-fns";
import { Logo } from "@/components/logo";

const LIMIT = 200;

function roleBadgeVariant(role: string): "default" | "secondary" | "outline" {
  if (role === "admin") return "default";
  if (role === "supervisor") return "secondary";
  return "outline";
}

export default function AdminDeletedNotes() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: me, isLoading: meLoading } = useGetMe();

  const { data, isLoading } = useListDeletedDriverNotes(
    { limit: LIMIT },
    {
      query: {
        enabled: !!me?.isAdmin,
        queryKey: getListDeletedDriverNotesQueryKey({ limit: LIMIT }),
      },
    },
  );

  const restoreNote = useRestoreDriverNote();

  if (!meLoading && me && !me.isAdmin) {
    return <Redirect to="/" />;
  }

  const handleRestore = (n: DeletedDriverNote) => {
    restoreNote.mutate(
      { id: n.id },
      {
        onSuccess: () => {
          qc.invalidateQueries({
            queryKey: getListDeletedDriverNotesQueryKey({ limit: LIMIT }),
          });
          // The driver-detail "live" notes panel is keyed by (week, kfiId);
          // invalidate that exact list so the restored note re-appears
          // immediately if a dispatcher is viewing the page.
          qc.invalidateQueries({
            queryKey: getListDriverNotesQueryKey(n.weekStart, n.kfiId),
          });
          toast({
            title: "Note restored",
            description: `Note for ${n.kfiId} (week of ${n.weekStart}) is visible to dispatchers again.`,
          });
        },
        onError: (err) =>
          toast({
            title: "Couldn't restore note",
            description: err instanceof Error ? err.message : "Unknown error",
            variant: "destructive",
          }),
      },
    );
  };

  const notes = data ?? [];

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background">
      <header className="sticky top-0 z-10 bg-sidebar text-sidebar-foreground border-b border-sidebar-border px-4 h-14 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
          <Link href="/" title="KFI Staffing" className="no-underline">
            <Logo />
          </Link>
          <div className="h-5 w-px bg-sidebar-border/60" />
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
            Admin · Hidden notes
          </h1>
        </div>
      </header>

      <main className="flex-1 px-4 py-6 max-w-6xl w-full mx-auto space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="font-display text-base flex items-center gap-2">
              <EyeOff className="h-4 w-4" />
              Soft-deleted driver-week notes
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground mb-4">
              Notes hidden by an admin via the driver-detail page. The row stays
              in the database for audit. Restoring clears the hide so the note
              shows up live on the driver-detail page again. Both the hide and
              the restore are recorded in the user audit log.
            </p>
            <div className="flex flex-wrap gap-2 mb-4 text-xs">
              <Badge variant="secondary" className="font-mono">
                {notes.length} hidden{notes.length === LIMIT ? "+" : ""}
              </Badge>
            </div>

            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
            ) : notes.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">
                No hidden notes. When an admin hides a note from the driver-detail
                page, it'll appear here so it can be restored.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[110px]">Week</TableHead>
                    <TableHead className="w-[110px]">Driver</TableHead>
                    <TableHead>Note</TableHead>
                    <TableHead className="w-[180px]">Author</TableHead>
                    <TableHead className="w-[180px]">Hidden</TableHead>
                    <TableHead className="w-[1%]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {notes.map((n) => (
                    <TableRow key={n.id} data-testid={`row-deleted-note-${n.id}`}>
                      <TableCell className="text-xs align-top whitespace-nowrap font-mono text-muted-foreground">
                        <Link
                          href={`/weeks/${n.weekStart}`}
                          className="underline decoration-dotted hover:text-foreground"
                        >
                          {n.weekStart}
                        </Link>
                      </TableCell>
                      <TableCell className="text-xs align-top whitespace-nowrap font-mono">
                        <Link
                          href={`/weeks/${n.weekStart}/drivers/${n.kfiId}`}
                          className="underline decoration-dotted hover:text-foreground"
                        >
                          {n.kfiId}
                        </Link>
                        {n.punchId != null && (
                          <div className="text-[10px] text-muted-foreground mt-0.5">
                            punch #{n.punchId}
                            {!n.punchExists && (
                              <span className="ml-1 italic">(orphaned)</span>
                            )}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-sm align-top">
                        <p className="whitespace-pre-wrap break-words max-w-[40ch]">
                          {n.body}
                        </p>
                      </TableCell>
                      <TableCell className="text-xs align-top">
                        <Badge
                          variant={roleBadgeVariant(n.authorRole)}
                          className="font-mono text-[10px] mr-1.5 capitalize"
                        >
                          {n.authorRole}
                        </Badge>
                        <span className="font-mono text-muted-foreground">
                          {n.authorEmail ?? "(deleted user)"}
                        </span>
                        <div className="text-[10px] text-muted-foreground font-mono mt-0.5">
                          wrote {format(new Date(n.createdAt), "yyyy-MM-dd HH:mm")}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs align-top">
                        <span className="font-mono text-muted-foreground">
                          {n.deletedByEmail ?? "(deleted user)"}
                        </span>
                        <div className="text-[10px] text-muted-foreground font-mono mt-0.5">
                          {format(new Date(n.deletedAt), "yyyy-MM-dd HH:mm")}
                        </div>
                      </TableCell>
                      <TableCell className="align-top">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => handleRestore(n)}
                          disabled={restoreNote.isPending}
                          data-testid={`button-restore-note-${n.id}`}
                        >
                          {restoreNote.isPending &&
                          restoreNote.variables?.id === n.id ? (
                            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                          ) : (
                            <Undo2 className="h-3 w-3 mr-1" />
                          )}
                          Restore
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
