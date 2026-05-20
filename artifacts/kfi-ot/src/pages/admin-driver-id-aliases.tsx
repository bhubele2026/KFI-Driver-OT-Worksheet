import { Fragment, useEffect, useMemo, useState } from "react";
import { formatPersonName } from "@/lib/format-name";
import { useTranslation } from "react-i18next";
import { Link, Redirect, useSearch } from "wouter";
import {
  useGetMe,
  useListDriverIdAliases,
  useCreateDriverIdAlias,
  useUpdateDriverIdAlias,
  useDeleteDriverIdAlias,
  useListCustomerIgnoredExternals,
  useDeleteCustomerIgnoredExternal,
  getListDriverIdAliasesQueryKey,
  getListCustomerIgnoredExternalsQueryKey,
  type DriverIdAlias,
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
  Ban,
  Link as LinkIcon,
  Loader2,
  Plus,
  Tag,
  Trash2,
} from "lucide-react";
import { format } from "date-fns";

type EditState = { externalId: string; kfiId: string } | null;

export default function AdminDriverIdAliases() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: me, isLoading: meLoading } = useGetMe();

  const search = useSearch();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const prefillId = params.get("id") ?? "";
  const prefillCustomer = params.get("customer") ?? "";
  const prefillSampleName = params.get("sampleName") ?? "";

  const { data, isLoading } = useListDriverIdAliases({
    query: {
      enabled: !!me?.isAdmin,
      queryKey: getListDriverIdAliasesQueryKey(),
    },
  });

  const createAlias = useCreateDriverIdAlias();
  const updateAlias = useUpdateDriverIdAlias();
  const deleteAlias = useDeleteDriverIdAlias();

  const ignoredQuery = useListCustomerIgnoredExternals({
    query: {
      enabled: !!me?.isAdmin,
      queryKey: getListCustomerIgnoredExternalsQueryKey(),
    },
  });
  const deleteIgnored = useDeleteCustomerIgnoredExternal();
  const ignoredRows = useMemo(() => ignoredQuery.data ?? [], [ignoredQuery.data]);
  const refetchIgnored = () =>
    qc.invalidateQueries({
      queryKey: getListCustomerIgnoredExternalsQueryKey(),
    });
  const handleDeleteIgnored = (id: number, label: string) => {
    deleteIgnored.mutate(
      { id },
      {
        onSuccess: () => {
          refetchIgnored();
          toast({
            title: t("adminDriverIdsExtra.ignoreLifted"),
            description: t("adminDriverIdsExtra.ignoreLiftedDesc", { label }),
          });
        },
        onError: (err) =>
          toast({
            title: t("adminDriverIdsExtra.liftFailed"),
            description: err instanceof Error ? err.message : t("errors.unknown"),
            variant: "destructive",
          }),
      },
    );
  };

  const [edit, setEdit] = useState<EditState>(null);
  const [newExternalId, setNewExternalId] = useState("");
  const [newKfiId, setNewKfiId] = useState("");
  const [newCustomer, setNewCustomer] = useState("");
  const [newSampleName, setNewSampleName] = useState("");

  // Pre-fill the create form when arriving from the customer-files panel link.
  useEffect(() => {
    if (prefillId) setNewExternalId(prefillId);
    if (prefillCustomer) setNewCustomer(prefillCustomer);
    if (prefillSampleName) setNewSampleName(prefillSampleName);
  }, [prefillId, prefillCustomer, prefillSampleName]);

  const drivers = useMemo(() => data?.drivers ?? [], [data]);
  const aliases = useMemo(() => data?.aliases ?? [], [data]);

  if (!meLoading && me && !me.isAdmin) {
    return <Redirect to="/" />;
  }

  const refetch = () =>
    qc.invalidateQueries({ queryKey: getListDriverIdAliasesQueryKey() });

  const resetCreateForm = () => {
    setNewExternalId("");
    setNewKfiId("");
    setNewCustomer("");
    setNewSampleName("");
  };

  const handleCreate = () => {
    const externalId = newExternalId.trim();
    if (!externalId || !newKfiId) return;
    createAlias.mutate(
      {
        data: {
          externalId,
          kfiId: newKfiId,
          customer: newCustomer.trim() || null,
          sampleName: newSampleName.trim() || null,
        },
      },
      {
        onSuccess: () => {
          resetCreateForm();
          refetch();
          toast({ title: t("adminDriverIdsExtra.mappingSaved"), description: externalId });
        },
        onError: (err) =>
          toast({
            title: t("adminDriverIdsExtra.saveFailed"),
            description: err instanceof Error ? err.message : t("errors.unknown"),
            variant: "destructive",
          }),
      },
    );
  };

  const handleSaveEdit = () => {
    if (!edit) return;
    updateAlias.mutate(
      { externalId: edit.externalId, data: { kfiId: edit.kfiId } },
      {
        onSuccess: () => {
          setEdit(null);
          refetch();
          toast({ title: t("adminDriverIdsExtra.mappingRepointed") });
        },
        onError: (err) =>
          toast({
            title: t("adminDriverIdsExtra.updateFailed"),
            description: err instanceof Error ? err.message : t("errors.unknown"),
            variant: "destructive",
          }),
      },
    );
  };

  const handleDelete = (a: DriverIdAlias) => {
    deleteAlias.mutate(
      { externalId: a.externalId },
      {
        onSuccess: () => {
          refetch();
          toast({
            title: t("adminDriverIdsExtra.mappingForgotten"),
            description: a.externalId,
          });
        },
        onError: (err) =>
          toast({
            title: t("adminDriverIdsExtra.deleteFailed"),
            description: err instanceof Error ? err.message : t("errors.unknown"),
            variant: "destructive",
          }),
      },
    );
  };

  const orphans = aliases.filter((a) => a.driverName == null).length;
  const archived = aliases.filter((a) => a.driverIsArchived === true).length;
  const conflictingExisting = useMemo(
    () =>
      newExternalId.trim()
        ? aliases.find(
            (a) =>
              a.externalId.toLowerCase() === newExternalId.trim().toLowerCase(),
          )
        : undefined,
    [newExternalId, aliases],
  );

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
              {t("common.backToUsers")}
            </Button>
          </Link>
          <h1 className="font-display font-bold text-lg tracking-tight">
            {t("adminDriverIds.title")}
          </h1>
        </div>
      </header>

      <main className="flex-1 px-4 py-6 max-w-5xl w-full mx-auto space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="font-display text-base flex items-center gap-2">
              <Plus className="h-4 w-4" />
              {t("adminDriverIdsExtra.addCardTitle")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground mb-4">
              {t("adminDriverIdsExtra.addDescription")}
            </p>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {t("adminDriverIdsExtra.externalIdLabel")}
                </label>
                <Input
                  value={newExternalId}
                  onChange={(e) => setNewExternalId(e.target.value)}
                  placeholder={t("adminDriverIdsExtra.externalIdPlaceholder")}
                  className="font-mono"
                />
                {conflictingExisting && (
                  <div className="text-[10px] text-amber-700 dark:text-amber-400 flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" />
                    {t("adminDriverIdsExtra.alreadyMappedBefore")}
                    {conflictingExisting.driverName ? formatPersonName(conflictingExisting.driverName) : conflictingExisting.kfiId}
                    {t("adminDriverIdsExtra.alreadyMappedAfter")}
                  </div>
                )}
              </div>
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {t("adminDriverIdsExtra.kfiDriverLabel")}
                </label>
                <Select value={newKfiId} onValueChange={setNewKfiId}>
                  <SelectTrigger>
                    <SelectValue placeholder={t("adminDriverIdsExtra.pickDriverPlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {drivers.map((d) => (
                      <SelectItem key={d.kfiId} value={d.kfiId}>
                        <span className="font-medium">{formatPersonName(d.name)}</span>
                        <span className="font-mono text-[10px] text-muted-foreground ml-2">
                          {d.kfiId} · {d.customer}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {t("adminDriverIdsExtra.customerLabel")}
                </label>
                <Input
                  value={newCustomer}
                  onChange={(e) => setNewCustomer(e.target.value)}
                  placeholder={t("adminDriverIdsExtra.customerPlaceholder")}
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {t("adminDriverIdsExtra.sampleNameLabel")}
                </label>
                <Input
                  value={newSampleName}
                  onChange={(e) => setNewSampleName(e.target.value)}
                  placeholder={t("adminDriverIdsExtra.sampleNamePlaceholder")}
                />
              </div>
            </div>
            <div className="mt-4 flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                onClick={handleCreate}
                disabled={
                  createAlias.isPending ||
                  !newExternalId.trim() ||
                  !newKfiId
                }
              >
                {createAlias.isPending && (
                  <Loader2 className="h-3 w-3 mr-2 animate-spin" />
                )}
                {t("adminDriverIdsExtra.saveMappingButton")}
              </Button>
              {(newExternalId || newKfiId || newCustomer || newSampleName) && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={resetCreateForm}
                >
                  {t("adminDriverIdsExtra.resetButton")}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="font-display text-base flex items-center gap-2">
              <Tag className="h-4 w-4" />
              {t("adminDriverIdsExtra.savedCardTitle")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2 mb-4 text-xs">
              <Badge variant="secondary" className="font-mono">
                {t("adminDriverIdsExtra.totalBadge", { count: aliases.length })}
              </Badge>
              {orphans > 0 && (
                <Badge variant="destructive" className="font-mono">
                  {t("adminDriverIdsExtra.orphansBadge", { count: orphans })}
                </Badge>
              )}
              {archived > 0 && (
                <Badge
                  variant="outline"
                  className="font-mono border-amber-500/50 text-amber-700 dark:text-amber-400"
                >
                  {t("adminDriverIdsExtra.archivedBadge", { count: archived })}
                </Badge>
              )}
            </div>

            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
            ) : aliases.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">
                {t("adminDriverIdsExtra.empty")}
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("adminDriverIdsExtra.headerExternalId")}</TableHead>
                    <TableHead>{t("adminDriverIdsExtra.headerMappedTo")}</TableHead>
                    <TableHead>{t("adminDriverIdsExtra.headerContext")}</TableHead>
                    <TableHead>{t("adminDriverIdsExtra.headerLastUpdated")}</TableHead>
                    <TableHead className="w-[1%]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {aliases.map((a) => {
                    const isEditing = edit?.externalId === a.externalId;
                    return (
                      <Fragment key={a.externalId}>
                        <TableRow>
                          <TableCell className="font-mono text-xs align-top">
                            {a.externalId}
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
                                    {t("adminDriverIdsExtra.archivedDriver")}
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
                                  {t("adminDriverIdsExtra.noLongerInRoster")}
                                </span>
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="text-xs align-top">
                            {a.customer || a.sampleName ? (
                              <div className="flex flex-col gap-0.5">
                                {a.customer && (
                                  <span className="font-medium">
                                    {a.customer}
                                  </span>
                                )}
                                {a.sampleName && (
                                  <span className="font-mono text-[10px] text-muted-foreground">
                                    {a.sampleName}
                                  </span>
                                )}
                              </div>
                            ) : (
                              <span className="text-[10px] text-muted-foreground italic">
                                —
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-xs align-top whitespace-nowrap">
                            <div className="font-mono text-muted-foreground">
                              {format(
                                new Date(a.updatedAt),
                                "yyyy-MM-dd HH:mm",
                              )}
                            </div>
                            {a.updatedByEmail && (
                              <div className="font-mono text-[10px] text-muted-foreground">
                                {t("adminDriverIdsExtra.byEmail", { email: a.updatedByEmail })}
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
                                          externalId: a.externalId,
                                          kfiId: a.kfiId,
                                        },
                                  )
                                }
                              >
                                <LinkIcon className="h-3 w-3 mr-1" />
                                {isEditing ? t("adminDriverIdsExtra.cancelButton") : t("adminDriverIdsExtra.changeDriverButton")}
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={() => handleDelete(a)}
                                disabled={deleteAlias.isPending}
                                title={t("adminDriverIdsExtra.deleteMappingTitle")}
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
                              <EditDriverRow
                                drivers={drivers}
                                currentKfiId={edit.kfiId}
                                onChange={(kfiId) =>
                                  setEdit({ ...edit, kfiId })
                                }
                                onSave={handleSaveEdit}
                                onCancel={() => setEdit(null)}
                                pending={updateAlias.isPending}
                                unchanged={edit.kfiId === a.kfiId}
                              />
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

        <Card>
          <CardHeader>
            <CardTitle className="font-display text-base flex items-center gap-2">
              <Ban className="h-4 w-4" />
              {t("adminDriverIdsExtra.ignoreCardTitle")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground mb-4">
              {t("adminDriverIdsExtra.ignoreDescription")}
            </p>
            {ignoredQuery.isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
            ) : ignoredRows.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">
                {t("adminDriverIdsExtra.ignoreEmpty")}
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("adminDriverIdsExtra.headerCustomer")}</TableHead>
                    <TableHead>{t("adminDriverIdsExtra.headerExternalId")}</TableHead>
                    <TableHead>{t("adminDriverIdsExtra.headerSampleName")}</TableHead>
                    <TableHead>{t("adminDriverIdsExtra.headerAdded")}</TableHead>
                    <TableHead className="w-[1%]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ignoredRows.map((r) => (
                    <TableRow key={r.id} data-testid={`row-ignored-${r.id}`}>
                      <TableCell className="text-xs align-top font-medium">
                        {r.customer}
                      </TableCell>
                      <TableCell className="font-mono text-xs align-top">
                        {r.externalId}
                      </TableCell>
                      <TableCell className="text-xs align-top">
                        {r.sampleName ? (
                          <span className="font-mono text-[11px]">
                            {r.sampleName}
                          </span>
                        ) : (
                          <span className="text-[10px] text-muted-foreground italic">
                            —
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs align-top whitespace-nowrap">
                        <div className="font-mono text-muted-foreground">
                          {format(new Date(r.createdAt), "yyyy-MM-dd HH:mm")}
                        </div>
                        {r.createdByEmail && (
                          <div className="font-mono text-[10px] text-muted-foreground">
                            by {r.createdByEmail}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="align-top">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            handleDeleteIgnored(
                              r.id,
                              `${r.customer} · ${r.externalId}`,
                            )
                          }
                          disabled={deleteIgnored.isPending}
                          title="Lift this ignore rule"
                          data-testid={`button-delete-ignored-${r.id}`}
                        >
                          <Trash2 className="h-3 w-3" />
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

function EditDriverRow({
  drivers,
  currentKfiId,
  onChange,
  onSave,
  onCancel,
  pending,
  unchanged,
}: {
  drivers: DriverInfo[];
  currentKfiId: string;
  onChange: (kfiId: string) => void;
  onSave: () => void;
  onCancel: () => void;
  pending: boolean;
  unchanged: boolean;
}) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="flex-1 min-w-[260px] space-y-1">
        <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Re-map to driver
        </label>
        <Select value={currentKfiId} onValueChange={onChange}>
          <SelectTrigger>
            <SelectValue placeholder="Pick a driver" />
          </SelectTrigger>
          <SelectContent>
            {drivers.map((d) => (
              <SelectItem key={d.kfiId} value={d.kfiId}>
                <span className="font-medium">{formatPersonName(d.name)}</span>
                <span className="font-mono text-[10px] text-muted-foreground ml-2">
                  {d.kfiId} · {d.customer}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button
        type="button"
        size="sm"
        onClick={onSave}
        disabled={pending || unchanged}
      >
        {pending && <Loader2 className="h-3 w-3 mr-2 animate-spin" />}
        Save
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}
