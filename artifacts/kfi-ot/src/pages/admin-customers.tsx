import { useMemo, useState } from "react";
import { Link, Redirect } from "wouter";
import {
  useGetMe,
  useListCustomers,
  useCreateCustomer,
  useUpdateCustomer,
  useDeleteCustomer,
  getListCustomersQueryKey,
  type Customer,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, BookOpen, Loader2, Plus, Save, Trash2 } from "lucide-react";
import { Logo } from "@/components/logo";

const EXTENSION_CHOICES: Array<"xlsx" | "pdf"> = ["xlsx", "pdf"];

interface RowDraft {
  displayName: string;
  filenameKeywords: string;
  extensions: Array<"xlsx" | "pdf">;
  active: boolean;
  sortOrder: number;
}

function toDraft(c: Customer): RowDraft {
  return {
    displayName: c.displayName,
    filenameKeywords: (c.filenameKeywords ?? []).join(", "),
    extensions: [...(c.extensions ?? [])],
    active: c.active,
    sortOrder: c.sortOrder,
  };
}

function draftsEqual(a: RowDraft, b: RowDraft): boolean {
  return (
    a.displayName === b.displayName &&
    a.filenameKeywords === b.filenameKeywords &&
    a.active === b.active &&
    a.sortOrder === b.sortOrder &&
    a.extensions.length === b.extensions.length &&
    a.extensions.every((e) => b.extensions.includes(e))
  );
}

function parseKeywords(input: string): string[] {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export default function AdminCustomers() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: me, isLoading: meLoading } = useGetMe();
  const { data, isLoading } = useListCustomers({
    query: { enabled: !!me, queryKey: getListCustomersQueryKey() },
  });

  const createMut = useCreateCustomer();
  const updateMut = useUpdateCustomer();
  const deleteMut = useDeleteCustomer();

  const [drafts, setDrafts] = useState<Record<number, RowDraft>>({});
  const [newDraft, setNewDraft] = useState<RowDraft>({
    displayName: "",
    filenameKeywords: "",
    extensions: ["xlsx", "pdf"],
    active: true,
    sortOrder: 1000,
  });

  const rows = useMemo(() => data ?? [], [data]);
  const originals = useMemo(() => {
    const map: Record<number, RowDraft> = {};
    for (const r of rows) map[r.id] = toDraft(r);
    return map;
  }, [rows]);

  if (!meLoading && me && !me.isAdmin) return <Redirect to="/" />;

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: getListCustomersQueryKey() });

  const draftOf = (c: Customer): RowDraft => drafts[c.id] ?? originals[c.id];

  const setDraft = (id: number, patch: Partial<RowDraft>) => {
    setDrafts((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? originals[id]), ...patch },
    }));
  };

  const handleSave = (c: Customer) => {
    const d = draftOf(c);
    if (!d.displayName.trim()) {
      toast({
        title: "Display name is required",
        variant: "destructive",
      });
      return;
    }
    updateMut.mutate(
      {
        id: c.id,
        data: {
          displayName: d.displayName.trim(),
          filenameKeywords: parseKeywords(d.filenameKeywords),
          extensions: d.extensions,
          active: d.active,
          sortOrder: d.sortOrder,
        },
      },
      {
        onSuccess: () => {
          invalidate();
          setDrafts((prev) => {
            const { [c.id]: _drop, ...rest } = prev;
            return rest;
          });
          toast({ title: `Saved "${d.displayName}"` });
        },
        onError: (err) =>
          toast({
            title: "Couldn't save",
            description: err instanceof Error ? err.message : String(err),
            variant: "destructive",
          }),
      },
    );
  };

  const handleDelete = (c: Customer) => {
    if (
      !window.confirm(
        `Permanently delete "${c.displayName}"? Historical punches stay; only the row is removed. Prefer un-checking "Active" if you might bring it back.`,
      )
    )
      return;
    deleteMut.mutate(
      { id: c.id },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: `Deleted "${c.displayName}"` });
        },
        onError: (err) =>
          toast({
            title: "Couldn't delete",
            description: err instanceof Error ? err.message : String(err),
            variant: "destructive",
          }),
      },
    );
  };

  const handleCreate = () => {
    if (!newDraft.displayName.trim()) {
      toast({ title: "Display name is required", variant: "destructive" });
      return;
    }
    createMut.mutate(
      {
        data: {
          displayName: newDraft.displayName.trim(),
          filenameKeywords: parseKeywords(newDraft.filenameKeywords),
          extensions: newDraft.extensions,
          active: newDraft.active,
          sortOrder: newDraft.sortOrder,
        },
      },
      {
        onSuccess: () => {
          invalidate();
          setNewDraft({
            displayName: "",
            filenameKeywords: "",
            extensions: ["xlsx", "pdf"],
            active: true,
            sortOrder: 1000,
          });
          toast({ title: "Customer added" });
        },
        onError: (err) =>
          toast({
            title: "Couldn't add",
            description: err instanceof Error ? err.message : String(err),
            variant: "destructive",
          }),
      },
    );
  };

  const renderExtensions = (
    draft: RowDraft,
    onChange: (next: Array<"xlsx" | "pdf">) => void,
    keyPrefix: string,
  ) => (
    <div className="flex gap-3">
      {EXTENSION_CHOICES.map((ext) => (
        <label
          key={ext}
          className="flex items-center gap-1 text-xs cursor-pointer"
        >
          <Checkbox
            checked={draft.extensions.includes(ext)}
            onCheckedChange={(checked) => {
              const next = checked
                ? Array.from(new Set([...draft.extensions, ext]))
                : draft.extensions.filter((e) => e !== ext);
              onChange(next as Array<"xlsx" | "pdf">);
            }}
            data-testid={`${keyPrefix}-ext-${ext}`}
          />
          <span className="font-mono">.{ext}</span>
        </label>
      ))}
    </div>
  );

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
            Customers
          </h1>
        </div>
      </header>

      <main className="flex-1 px-4 py-6 max-w-6xl w-full mx-auto space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="font-display text-base">
              Customer list
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground mb-4">
              The single source of truth for filename routing, the per-week
              customer files panel, the manual-punch customer dropdown, and the
              timesheets sidebar ordering. <span className="font-medium">Filename keywords</span>{" "}
              are matched case-insensitively against uploaded filenames — list
              every spelling the dispatcher actually sees. <span className="font-medium">Sort order</span>{" "}
              controls the per-week panel order (lower first). Un-check{" "}
              <span className="font-medium">Active</span> to hide a customer
              without losing its history.
            </p>

            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[18%]">Display name</TableHead>
                    <TableHead>Filename keywords</TableHead>
                    <TableHead className="w-[120px]">Extensions</TableHead>
                    <TableHead className="w-[80px]">Sort</TableHead>
                    <TableHead className="w-[80px]">Active</TableHead>
                    <TableHead className="w-[170px]">Last updated</TableHead>
                    <TableHead className="w-[160px]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((c) => {
                    const draft = draftOf(c);
                    const dirty = !draftsEqual(draft, originals[c.id]);
                    const saving =
                      updateMut.isPending &&
                      updateMut.variables?.id === c.id;
                    const deleting =
                      deleteMut.isPending &&
                      deleteMut.variables?.id === c.id;
                    return (
                      <TableRow key={c.id}>
                        <TableCell>
                          <Input
                            value={draft.displayName}
                            onChange={(e) =>
                              setDraft(c.id, { displayName: e.target.value })
                            }
                            data-testid={`customer-name-${c.id}`}
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            value={draft.filenameKeywords}
                            placeholder="comma-separated, lowercase"
                            onChange={(e) =>
                              setDraft(c.id, {
                                filenameKeywords: e.target.value,
                              })
                            }
                            data-testid={`customer-keywords-${c.id}`}
                          />
                        </TableCell>
                        <TableCell>
                          {renderExtensions(
                            draft,
                            (next) => setDraft(c.id, { extensions: next }),
                            `customer-${c.id}`,
                          )}
                        </TableCell>
                        <TableCell>
                          <Input
                            type="number"
                            value={draft.sortOrder}
                            onChange={(e) =>
                              setDraft(c.id, {
                                sortOrder: Number(e.target.value) || 0,
                              })
                            }
                            data-testid={`customer-sort-${c.id}`}
                          />
                        </TableCell>
                        <TableCell>
                          <Checkbox
                            checked={draft.active}
                            onCheckedChange={(checked) =>
                              setDraft(c.id, { active: Boolean(checked) })
                            }
                            data-testid={`customer-active-${c.id}`}
                          />
                        </TableCell>
                        <TableCell className="text-[11px] font-mono text-muted-foreground">
                          {new Date(c.updatedAt).toLocaleString()}
                          {c.updatedByEmail && (
                            <div className="text-muted-foreground/80">
                              by {c.updatedByEmail}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-2 justify-end">
                            <Link href={`/admin/customers/${c.id}/lessons`}>
                              <Button
                                size="sm"
                                variant="ghost"
                                title="Review AI-learned lessons"
                                data-testid={`customer-lessons-${c.id}`}
                              >
                                <BookOpen className="h-3 w-3 mr-1" />
                                Lessons
                              </Button>
                            </Link>
                            <Button
                              size="sm"
                              variant="default"
                              disabled={!dirty || saving}
                              onClick={() => handleSave(c)}
                              data-testid={`customer-save-${c.id}`}
                            >
                              {saving ? (
                                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                              ) : (
                                <Save className="h-3 w-3 mr-1" />
                              )}
                              Save
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={deleting}
                              onClick={() => handleDelete(c)}
                              data-testid={`customer-delete-${c.id}`}
                            >
                              {deleting ? (
                                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                              ) : (
                                <Trash2 className="h-3 w-3 mr-1" />
                              )}
                              Delete
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="font-display text-base">
              Add customer
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
              <div className="md:col-span-3 space-y-1">
                <Label className="text-xs">Display name</Label>
                <Input
                  value={newDraft.displayName}
                  placeholder="Acme Logistics"
                  onChange={(e) =>
                    setNewDraft((d) => ({ ...d, displayName: e.target.value }))
                  }
                  data-testid="new-customer-name"
                />
              </div>
              <div className="md:col-span-4 space-y-1">
                <Label className="text-xs">Filename keywords</Label>
                <Input
                  value={newDraft.filenameKeywords}
                  placeholder="acme, acme-weekly"
                  onChange={(e) =>
                    setNewDraft((d) => ({
                      ...d,
                      filenameKeywords: e.target.value,
                    }))
                  }
                  data-testid="new-customer-keywords"
                />
              </div>
              <div className="md:col-span-2 space-y-1">
                <Label className="text-xs">Extensions</Label>
                {renderExtensions(
                  newDraft,
                  (next) => setNewDraft((d) => ({ ...d, extensions: next })),
                  "new-customer",
                )}
              </div>
              <div className="md:col-span-1 space-y-1">
                <Label className="text-xs">Sort</Label>
                <Input
                  type="number"
                  value={newDraft.sortOrder}
                  onChange={(e) =>
                    setNewDraft((d) => ({
                      ...d,
                      sortOrder: Number(e.target.value) || 0,
                    }))
                  }
                  data-testid="new-customer-sort"
                />
              </div>
              <div className="md:col-span-2 flex justify-end">
                <Button
                  disabled={createMut.isPending}
                  onClick={handleCreate}
                  data-testid="new-customer-add"
                >
                  {createMut.isPending ? (
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                  ) : (
                    <Plus className="h-3 w-3 mr-1" />
                  )}
                  Add customer
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
