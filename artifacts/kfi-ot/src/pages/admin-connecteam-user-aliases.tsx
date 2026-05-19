import { Fragment, useMemo, useState } from "react";
import { formatPersonName } from "@/lib/format-name";
import { Link, Redirect } from "wouter";
import {
  useGetMe,
  useListConnecteamUserAliases,
  useCreateConnecteamUserAlias,
  useUpdateConnecteamUserAlias,
  useDeleteConnecteamUserAlias,
  getListConnecteamUserAliasesQueryKey,
  type ConnecteamUserAlias,
  type DriverInfo,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  AlertTriangle,
  ArrowLeft,
  Link as LinkIcon,
  Loader2,
  Plus,
  Tag,
  Trash2,
} from "lucide-react";
import { format } from "date-fns";

type EditState = { ctUserId: number; kfiId: string } | null;

export default function AdminConnecteamUserAliases() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: me, isLoading: meLoading } = useGetMe();

  const { data, isLoading } = useListConnecteamUserAliases({
    query: {
      enabled: !!me?.isAdmin,
      queryKey: getListConnecteamUserAliasesQueryKey(),
    },
  });

  const createAlias = useCreateConnecteamUserAlias();
  const updateAlias = useUpdateConnecteamUserAlias();
  const deleteAlias = useDeleteConnecteamUserAlias();

  const [edit, setEdit] = useState<EditState>(null);
  const [newCtUserId, setNewCtUserId] = useState("");
  const [newKfiId, setNewKfiId] = useState("");
  const [newNote, setNewNote] = useState("");

  const drivers = useMemo<DriverInfo[]>(() => data?.drivers ?? [], [data]);
  const aliases = useMemo<ConnecteamUserAlias[]>(
    () => data?.aliases ?? [],
    [data],
  );

  if (!meLoading && me && !me.isAdmin) {
    return <Redirect to="/" />;
  }

  const refetch = () =>
    qc.invalidateQueries({ queryKey: getListConnecteamUserAliasesQueryKey() });

  const resetCreateForm = () => {
    setNewCtUserId("");
    setNewKfiId("");
    setNewNote("");
  };

  const handleCreate = () => {
    const ctUserId = Number(newCtUserId.trim());
    if (!Number.isFinite(ctUserId) || ctUserId <= 0 || !newKfiId) return;
    createAlias.mutate(
      {
        data: {
          ctUserId,
          kfiId: newKfiId,
          note: newNote.trim() || null,
        },
      },
      {
        onSuccess: () => {
          resetCreateForm();
          refetch();
          toast({
            title: "Alias saved",
            description: `Connecteam user ${ctUserId} mapped.`,
          });
        },
        onError: (err) =>
          toast({
            title: "Couldn't save alias",
            description: err instanceof Error ? err.message : "Unknown error",
            variant: "destructive",
          }),
      },
    );
  };

  const handleSaveEdit = () => {
    if (!edit) return;
    updateAlias.mutate(
      { ctUserId: edit.ctUserId, data: { kfiId: edit.kfiId } },
      {
        onSuccess: () => {
          setEdit(null);
          refetch();
          toast({ title: "Alias re-pointed" });
        },
        onError: (err) =>
          toast({
            title: "Couldn't update alias",
            description: err instanceof Error ? err.message : "Unknown error",
            variant: "destructive",
          }),
      },
    );
  };

  const handleDelete = (a: ConnecteamUserAlias) => {
    if (a.seededFromStatic) {
      toast({
        title: "Can't delete a seeded alias",
        description:
          "This entry comes from the USER_ID_ALIASES_LD static seed in code. Override it by saving a new mapping for the same Connecteam user id.",
        variant: "destructive",
      });
      return;
    }
    deleteAlias.mutate(
      { ctUserId: a.ctUserId },
      {
        onSuccess: () => {
          refetch();
          toast({
            title: "Alias forgotten",
            description: `Connecteam user ${a.ctUserId}`,
          });
        },
        onError: (err) =>
          toast({
            title: "Couldn't delete alias",
            description: err instanceof Error ? err.message : "Unknown error",
            variant: "destructive",
          }),
      },
    );
  };

  const orphans = aliases.filter((a) => a.driverName == null).length;
  const seeded = aliases.filter((a) => a.seededFromStatic).length;

  const conflictingExisting = useMemo(() => {
    const n = Number(newCtUserId.trim());
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return aliases.find((a) => a.ctUserId === n);
  }, [newCtUserId, aliases]);

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
            Connecteam user aliases
          </h1>
        </div>
      </header>

      <main className="flex-1 px-4 py-6 max-w-5xl w-full mx-auto space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="font-display text-base flex items-center gap-2">
              <Plus className="h-4 w-4" />
              Add a new alias
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground mb-4">
              Map a Connecteam <code className="font-mono">userId</code> to an
              existing KFI driver. Use this when the same driver shows up on
              more than one time-clock under different Connecteam ids — refresh
              will merge their punches into the single KFI driver. Saved rows
              take effect on the next refresh; they override the static
              <code className="font-mono"> USER_ID_ALIASES_LD</code> seed.
            </p>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Connecteam user id
                </label>
                <Input
                  value={newCtUserId}
                  onChange={(e) => setNewCtUserId(e.target.value)}
                  placeholder="e.g. 12345678"
                  className="font-mono"
                  inputMode="numeric"
                  data-testid="input-new-ct-user-id"
                />
                {conflictingExisting && (
                  <div className="text-[10px] text-amber-700 dark:text-amber-400 flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" />
                    Already mapped to{" "}
                    {conflictingExisting.driverName
                      ? formatPersonName(conflictingExisting.driverName)
                      : conflictingExisting.kfiId}
                    . Saving will overwrite it.
                  </div>
                )}
              </div>
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  KFI driver
                </label>
                <Select value={newKfiId} onValueChange={setNewKfiId}>
                  <SelectTrigger data-testid="select-new-kfi-id">
                    <SelectValue placeholder="Pick a driver" />
                  </SelectTrigger>
                  <SelectContent>
                    {drivers.map((d) => (
                      <SelectItem key={d.kfiId} value={d.kfiId}>
                        <span className="font-medium">
                          {formatPersonName(d.name)}
                        </span>
                        <span className="font-mono text-[10px] text-muted-foreground ml-2">
                          {d.kfiId}
                          {d.customer ? ` · ${d.customer}` : ""}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1 md:col-span-2">
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Note (optional)
                </label>
                <Input
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder="Why this alias exists"
                />
              </div>
            </div>
            <div className="mt-4 flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                onClick={handleCreate}
                data-testid="button-save-alias"
                disabled={
                  createAlias.isPending ||
                  !newCtUserId.trim() ||
                  !newKfiId
                }
              >
                {createAlias.isPending && (
                  <Loader2 className="h-3 w-3 mr-2 animate-spin" />
                )}
                Save alias
              </Button>
              {(newCtUserId || newKfiId || newNote) && (
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
              <Tag className="h-4 w-4" />
              Saved aliases
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2 mb-4 text-xs">
              <Badge variant="secondary" className="font-mono">
                {aliases.length} total
              </Badge>
              {seeded > 0 && (
                <Badge
                  variant="outline"
                  className="font-mono border-sky-500/50 text-sky-700 dark:text-sky-400"
                >
                  {seeded} from static seed
                </Badge>
              )}
              {orphans > 0 && (
                <Badge variant="destructive" className="font-mono">
                  {orphans} pointing at deleted driver
                </Badge>
              )}
            </div>

            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
            ) : aliases.length === 0 ? (
              <p
                className="text-sm text-muted-foreground italic"
                data-testid="text-empty-aliases"
              >
                No aliases yet. Add one above whenever a refresh surfaces an
                unresolved Connecteam user id.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Connecteam id</TableHead>
                    <TableHead>Mapped to</TableHead>
                    <TableHead>Note</TableHead>
                    <TableHead>Last updated</TableHead>
                    <TableHead className="w-[1%]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {aliases.map((a) => {
                    const isEditing = edit?.ctUserId === a.ctUserId;
                    return (
                      <Fragment key={a.ctUserId}>
                        <TableRow data-testid={`row-alias-${a.ctUserId}`}>
                          <TableCell className="font-mono text-xs align-top">
                            {a.ctUserId}
                            {a.seededFromStatic && (
                              <div className="text-[10px] uppercase tracking-wider text-sky-700 dark:text-sky-400 font-mono mt-1">
                                static seed
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="text-xs align-top">
                            {a.driverName ? (
                              <div className="flex flex-col gap-0.5">
                                <span className="font-medium">
                                  {formatPersonName(a.driverName)}
                                </span>
                                <span className="font-mono text-[10px] text-muted-foreground">
                                  {a.kfiId}
                                  {a.driverCustomer
                                    ? ` · ${a.driverCustomer}`
                                    : ""}
                                </span>
                                {a.driverIsArchived && (
                                  <span className="text-[10px] uppercase tracking-wider text-amber-700 dark:text-amber-400 font-mono flex items-center gap-1">
                                    <AlertTriangle className="h-3 w-3" />
                                    Archived driver
                                  </span>
                                )}
                              </div>
                            ) : (
                              <div className="flex flex-col gap-0.5">
                                <span className="font-mono text-[10px]">
                                  {a.kfiId}
                                </span>
                                <span className="text-[10px] uppercase tracking-wider text-rose-600 dark:text-rose-400 font-mono flex items-center gap-1">
                                  <AlertTriangle className="h-3 w-3" />
                                  Driver no longer in roster
                                </span>
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="text-xs align-top">
                            {a.note ? (
                              <span className="text-muted-foreground">
                                {a.note}
                              </span>
                            ) : (
                              <span className="text-[10px] text-muted-foreground italic">
                                —
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-xs align-top whitespace-nowrap">
                            {a.seededFromStatic ? (
                              <span className="text-[10px] text-muted-foreground italic">
                                —
                              </span>
                            ) : (
                              <>
                                <div className="font-mono text-muted-foreground">
                                  {format(
                                    new Date(a.updatedAt),
                                    "yyyy-MM-dd HH:mm",
                                  )}
                                </div>
                                {a.updatedByEmail && (
                                  <div className="font-mono text-[10px] text-muted-foreground">
                                    by {a.updatedByEmail}
                                  </div>
                                )}
                              </>
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
                                      : { ctUserId: a.ctUserId, kfiId: a.kfiId },
                                  )
                                }
                                data-testid={`button-edit-${a.ctUserId}`}
                              >
                                <LinkIcon className="h-3 w-3 mr-1" />
                                {isEditing ? "Cancel" : "Change driver"}
                              </Button>
                              {!a.seededFromStatic && (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => handleDelete(a)}
                                  disabled={deleteAlias.isPending}
                                  title="Delete this alias"
                                  data-testid={`button-delete-${a.ctUserId}`}
                                >
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                        {isEditing && edit && (
                          <TableRow className="bg-muted/30 hover:bg-muted/30">
                            <TableCell />
                            <TableCell colSpan={4} className="py-3">
                              <div className="flex items-center gap-2">
                                <Select
                                  value={edit.kfiId}
                                  onValueChange={(kfiId) =>
                                    setEdit({ ...edit, kfiId })
                                  }
                                >
                                  <SelectTrigger className="max-w-md">
                                    <SelectValue placeholder="Pick a driver" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {drivers.map((d) => (
                                      <SelectItem key={d.kfiId} value={d.kfiId}>
                                        <span className="font-medium">
                                          {formatPersonName(d.name)}
                                        </span>
                                        <span className="font-mono text-[10px] text-muted-foreground ml-2">
                                          {d.kfiId}
                                          {d.customer ? ` · ${d.customer}` : ""}
                                        </span>
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                                <Button
                                  size="sm"
                                  onClick={handleSaveEdit}
                                  disabled={
                                    updateAlias.isPending ||
                                    edit.kfiId === a.kfiId
                                  }
                                >
                                  {updateAlias.isPending && (
                                    <Loader2 className="h-3 w-3 mr-2 animate-spin" />
                                  )}
                                  Save
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => setEdit(null)}
                                >
                                  Cancel
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
