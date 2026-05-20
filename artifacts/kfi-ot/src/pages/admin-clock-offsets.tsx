import { Fragment, useMemo, useState } from "react";
import { Link, Redirect } from "wouter";
import {
  useGetMe,
  useListClockOffsets,
  useCreateClockOffset,
  useUpdateClockOffset,
  useDeleteClockOffset,
  getListClockOffsetsQueryKey,
  type ClockOffset,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  Clock,
  Loader2,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import { format } from "date-fns";

type EditState = { clockId: string; hoursOffset: string; note: string } | null;

export default function AdminClockOffsets() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: me, isLoading: meLoading } = useGetMe();

  const { data: offsets, isLoading } = useListClockOffsets({
    query: {
      enabled: !!me?.isAdmin,
      queryKey: getListClockOffsetsQueryKey(),
    },
  });

  const createOffset = useCreateClockOffset();
  const updateOffset = useUpdateClockOffset();
  const deleteOffset = useDeleteClockOffset();

  const [edit, setEdit] = useState<EditState>(null);
  const [newClockId, setNewClockId] = useState("");
  const [newHours, setNewHours] = useState("");
  const [newNote, setNewNote] = useState("");

  const rows = useMemo<ClockOffset[]>(() => offsets ?? [], [offsets]);

  if (!meLoading && me && !me.isAdmin) {
    return <Redirect to="/" />;
  }

  const refetch = () =>
    qc.invalidateQueries({ queryKey: getListClockOffsetsQueryKey() });

  const resetCreateForm = () => {
    setNewClockId("");
    setNewHours("");
    setNewNote("");
  };

  const conflictingExisting = useMemo(() => {
    const id = newClockId.trim();
    if (!id) return undefined;
    return rows.find((r) => r.clockId === id);
  }, [newClockId, rows]);

  const handleCreate = () => {
    const clockId = newClockId.trim();
    const hoursOffset = Number(newHours);
    if (!clockId || !Number.isFinite(hoursOffset)) return;
    createOffset.mutate(
      {
        data: {
          clockId,
          hoursOffset,
          note: newNote.trim() || null,
        },
      },
      {
        onSuccess: () => {
          resetCreateForm();
          refetch();
          toast({
            title: "Offset saved",
            description: `Clock ${clockId} → ${hoursOffset >= 0 ? "+" : ""}${hoursOffset}h`,
          });
        },
        onError: (err) =>
          toast({
            title: "Couldn't save offset",
            description: err instanceof Error ? err.message : "Unknown error",
            variant: "destructive",
          }),
      },
    );
  };

  const handleSaveEdit = () => {
    if (!edit) return;
    const hoursOffset = Number(edit.hoursOffset);
    if (!Number.isFinite(hoursOffset)) {
      toast({
        title: "Hours offset must be a number",
        variant: "destructive",
      });
      return;
    }
    updateOffset.mutate(
      {
        clockId: edit.clockId,
        data: {
          hoursOffset,
          note: edit.note.trim() || null,
        },
      },
      {
        onSuccess: () => {
          setEdit(null);
          refetch();
          toast({ title: "Offset updated" });
        },
        onError: (err) =>
          toast({
            title: "Couldn't update offset",
            description: err instanceof Error ? err.message : "Unknown error",
            variant: "destructive",
          }),
      },
    );
  };

  const handleDelete = (r: ClockOffset) => {
    deleteOffset.mutate(
      { clockId: r.clockId },
      {
        onSuccess: () => {
          refetch();
          toast({
            title: "Offset removed",
            description: `Clock ${r.clockId}`,
          });
        },
        onError: (err) =>
          toast({
            title: "Couldn't delete offset",
            description: err instanceof Error ? err.message : "Unknown error",
            variant: "destructive",
          }),
      },
    );
  };

  const formatOffset = (h: number) =>
    `${h > 0 ? "+" : ""}${h.toFixed(2)}h`;

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background">
      <header className="sticky top-0 z-10 bg-sidebar text-sidebar-foreground border-b border-sidebar-border px-4 py-3 flex items-center justify-between shadow-sm">
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
            Clock offsets
          </h1>
        </div>
      </header>

      <main className="flex-1 px-4 py-6 max-w-5xl w-full mx-auto space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="font-display text-base flex items-center gap-2">
              <Plus className="h-4 w-4" />
              Add a clock offset
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground mb-4">
              Add an hour offset for a Connecteam{" "}
              <code className="font-mono">clock_id</code> whose raw timestamps
              drift from the wall-clock the driver actually punched. The offset
              (positive or negative, fractions allowed) is added to every punch
              from that clock on the next refresh. Saving the same clock id
              again overwrites the existing row.
            </p>
            <div className="grid gap-3 md:grid-cols-3">
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Connecteam clock id
                </label>
                <Input
                  value={newClockId}
                  onChange={(e) => setNewClockId(e.target.value)}
                  placeholder="e.g. 2005033"
                  className="font-mono"
                  inputMode="numeric"
                  data-testid="input-new-clock-id"
                />
                {conflictingExisting && (
                  <div className="text-[10px] text-amber-700 dark:text-amber-400">
                    Already mapped to{" "}
                    {formatOffset(conflictingExisting.hoursOffset)}. Saving will
                    overwrite it.
                  </div>
                )}
              </div>
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Hours offset
                </label>
                <Input
                  value={newHours}
                  onChange={(e) => setNewHours(e.target.value)}
                  placeholder="e.g. 1 or -0.5"
                  className="font-mono"
                  inputMode="decimal"
                  type="number"
                  step="0.25"
                  data-testid="input-new-hours-offset"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Note (optional)
                </label>
                <Input
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder="Why this offset exists"
                />
              </div>
            </div>
            <div className="mt-4 flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                onClick={handleCreate}
                data-testid="button-save-clock-offset"
                disabled={
                  createOffset.isPending ||
                  !newClockId.trim() ||
                  newHours === "" ||
                  !Number.isFinite(Number(newHours))
                }
              >
                {createOffset.isPending && (
                  <Loader2 className="h-3 w-3 mr-2 animate-spin" />
                )}
                Save offset
              </Button>
              {(newClockId || newHours || newNote) && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={resetCreateForm}
                >
                  Reset
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="font-display text-base flex items-center gap-2">
              <Clock className="h-4 w-4" />
              Saved offsets
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2 mb-4 text-xs">
              <Badge variant="secondary" className="font-mono">
                {rows.length} total
              </Badge>
            </div>

            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
            ) : rows.length === 0 ? (
              <p
                className="text-sm text-muted-foreground italic"
                data-testid="text-empty-clock-offsets"
              >
                No clock offsets configured. Refresh-from-Connecteam will use
                the raw timestamps as-is.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Clock id</TableHead>
                    <TableHead>Offset</TableHead>
                    <TableHead>Note</TableHead>
                    <TableHead>Last updated</TableHead>
                    <TableHead className="w-[1%]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => {
                    const isEditing = edit?.clockId === r.clockId;
                    return (
                      <Fragment key={r.clockId}>
                        <TableRow data-testid={`row-clock-offset-${r.clockId}`}>
                          <TableCell className="font-mono text-xs align-top">
                            {r.clockId}
                          </TableCell>
                          <TableCell className="font-mono text-xs align-top">
                            {formatOffset(r.hoursOffset)}
                          </TableCell>
                          <TableCell className="text-xs align-top">
                            {r.note ? (
                              <span className="text-muted-foreground">
                                {r.note}
                              </span>
                            ) : (
                              <span className="text-[10px] text-muted-foreground italic">
                                —
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-xs align-top whitespace-nowrap">
                            <div className="font-mono text-muted-foreground">
                              {format(
                                new Date(r.updatedAt),
                                "yyyy-MM-dd HH:mm",
                              )}
                            </div>
                            {r.updatedByEmail && (
                              <div className="font-mono text-[10px] text-muted-foreground">
                                by {r.updatedByEmail}
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="align-top">
                            <div className="flex justify-end gap-1">
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  setEdit(
                                    isEditing
                                      ? null
                                      : {
                                          clockId: r.clockId,
                                          hoursOffset: String(r.hoursOffset),
                                          note: r.note ?? "",
                                        },
                                  )
                                }
                                data-testid={`button-edit-${r.clockId}`}
                              >
                                {isEditing ? "Cancel" : "Edit"}
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={() => handleDelete(r)}
                                disabled={deleteOffset.isPending}
                                title="Delete this offset"
                                data-testid={`button-delete-${r.clockId}`}
                              >
                                <Trash2 className="h-3 w-3" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                        {isEditing && edit && (
                          <TableRow className="bg-muted/30 hover:bg-muted/30">
                            <TableCell />
                            <TableCell colSpan={4} className="py-3">
                              <div className="flex flex-wrap items-center gap-2">
                                <Input
                                  value={edit.hoursOffset}
                                  onChange={(e) =>
                                    setEdit({
                                      ...edit,
                                      hoursOffset: e.target.value,
                                    })
                                  }
                                  className="font-mono max-w-[10rem]"
                                  inputMode="decimal"
                                  type="number"
                                  step="0.25"
                                  placeholder="Hours"
                                  data-testid={`input-edit-hours-${r.clockId}`}
                                />
                                <Input
                                  value={edit.note}
                                  onChange={(e) =>
                                    setEdit({ ...edit, note: e.target.value })
                                  }
                                  placeholder="Note"
                                  className="max-w-md"
                                  data-testid={`input-edit-note-${r.clockId}`}
                                />
                                <Button
                                  size="sm"
                                  onClick={handleSaveEdit}
                                  disabled={
                                    updateOffset.isPending ||
                                    !Number.isFinite(Number(edit.hoursOffset))
                                  }
                                  data-testid={`button-save-edit-${r.clockId}`}
                                >
                                  {updateOffset.isPending ? (
                                    <Loader2 className="h-3 w-3 mr-2 animate-spin" />
                                  ) : (
                                    <Save className="h-3 w-3 mr-2" />
                                  )}
                                  Save
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
