import { useMemo, useState } from "react";
import { Link, Redirect, useRoute } from "wouter";
import {
  useGetMe,
  useListCustomers,
  useListCustomerExtractionLessons,
  useUpdateCustomerExtractionLesson,
  useDeleteCustomerExtractionLesson,
  getListCustomersQueryKey,
  getListCustomerExtractionLessonsQueryKey,
  type CustomerExtractionLesson,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
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
import {
  ArrowLeft,
  BookOpen,
  Loader2,
  MessageSquare,
  Save,
  Trash2,
} from "lucide-react";
import { format } from "date-fns";
import { Logo } from "@/components/logo";

type EditState = { id: number; text: string } | null;

export default function AdminCustomerLessons() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, params] = useRoute<{ id: string }>("/admin/customers/:id/lessons");
  const customerId = params?.id ? parseInt(params.id, 10) : NaN;

  const { data: me, isLoading: meLoading } = useGetMe();
  const { data: customers } = useListCustomers({
    query: {
      enabled: !!me?.isAdmin,
      queryKey: getListCustomersQueryKey(),
    },
  });
  const customer = useMemo(
    () => (customers ?? []).find((c) => c.id === customerId) ?? null,
    [customers, customerId],
  );
  const customerName = customer?.displayName ?? "";

  const { data, isLoading } = useListCustomerExtractionLessons(customerName, {
    query: {
      enabled: !!me?.isAdmin && customerName.length > 0,
      queryKey: getListCustomerExtractionLessonsQueryKey(customerName),
    },
  });

  const updateMut = useUpdateCustomerExtractionLesson();
  const deleteMut = useDeleteCustomerExtractionLesson();

  const [edit, setEdit] = useState<EditState>(null);

  if (!meLoading && me && !me.isAdmin) return <Redirect to="/" />;
  if (!meLoading && !Number.isFinite(customerId)) {
    return <Redirect to="/admin/customers" />;
  }

  const lessons = data?.lessons ?? [];
  const activeChars = data?.activeChars ?? 0;
  const maxChars = data?.maxLessonChars ?? 6000;
  const pct = Math.min(100, Math.round((activeChars / Math.max(1, maxChars)) * 100));
  const overBudget = activeChars >= maxChars;
  const nearBudget = !overBudget && pct >= 80;

  const refetch = () =>
    qc.invalidateQueries({
      queryKey: getListCustomerExtractionLessonsQueryKey(customerName),
    });

  const handleSaveText = (l: CustomerExtractionLesson) => {
    if (!edit || edit.id !== l.id) return;
    const t = edit.text.trim();
    if (t.length === 0 || t.length > 1000) {
      toast({
        title: "Lesson text must be 1–1000 characters",
        variant: "destructive",
      });
      return;
    }
    updateMut.mutate(
      {
        customer: customerName,
        lessonId: l.id,
        data: { lessonText: t },
      },
      {
        onSuccess: () => {
          setEdit(null);
          refetch();
          toast({ title: "Lesson updated" });
        },
        onError: (err) =>
          toast({
            title: "Update failed",
            description: err instanceof Error ? err.message : "Unknown error",
            variant: "destructive",
          }),
      },
    );
  };

  const handleToggleActive = (l: CustomerExtractionLesson) => {
    updateMut.mutate(
      {
        customer: customerName,
        lessonId: l.id,
        data: { active: !l.active },
      },
      {
        onSuccess: () => {
          refetch();
          toast({
            title: l.active ? "Lesson deactivated" : "Lesson reactivated",
          });
        },
        onError: (err) =>
          toast({
            title: "Toggle failed",
            description: err instanceof Error ? err.message : "Unknown error",
            variant: "destructive",
          }),
      },
    );
  };

  const handleDelete = (l: CustomerExtractionLesson) => {
    if (
      !window.confirm(
        `Permanently delete this lesson?\n\n"${l.lessonText.slice(0, 120)}${
          l.lessonText.length > 120 ? "…" : ""
        }"`,
      )
    ) {
      return;
    }
    deleteMut.mutate(
      { customer: customerName, lessonId: l.id },
      {
        onSuccess: () => {
          refetch();
          toast({ title: "Lesson deleted" });
        },
        onError: (err) =>
          toast({
            title: "Delete failed",
            description: err instanceof Error ? err.message : "Unknown error",
            variant: "destructive",
          }),
      },
    );
  };

  const activeCount = lessons.filter((l) => l.active).length;
  const inactiveCount = lessons.length - activeCount;

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background">
      <header className="sticky top-0 z-10 bg-sidebar text-sidebar-foreground border-b border-sidebar-border px-4 h-14 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
          <Link href="/" title="KFI Staffing" className="no-underline">
            <Logo />
          </Link>
          <div className="h-5 w-px bg-sidebar-border/60" />
          <Link href="/admin/customers">
            <Button
              variant="ghost"
              size="sm"
              className="text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground h-8"
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to customers
            </Button>
          </Link>
          <h1 className="font-display font-bold text-lg tracking-tight">
            Lessons · {customerName || "…"}
          </h1>
        </div>
      </header>

      <main className="flex-1 px-4 py-6 max-w-5xl w-full mx-auto space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="font-display text-base flex items-center gap-2">
              <BookOpen className="h-4 w-4" />
              AI-learned lessons
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Every chat fix the dispatcher saves a "lesson" for is prepended to
              future AI extractions for this customer so the model stops
              repeating the same mistake. Deactivate lessons that are stale or
              wrong; delete the ones that were never correct.
            </p>

            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant="secondary" className="font-mono">
                {lessons.length} total
              </Badge>
              <Badge variant="secondary" className="font-mono">
                {activeCount} active
              </Badge>
              {inactiveCount > 0 && (
                <Badge variant="outline" className="font-mono">
                  {inactiveCount} inactive
                </Badge>
              )}
            </div>

            <div
              className="rounded-md border p-3 space-y-2"
              data-testid="lesson-budget"
            >
              <div className="flex items-center justify-between text-xs font-mono">
                <span className="uppercase tracking-wider text-muted-foreground">
                  Prompt budget
                </span>
                <span
                  className={
                    overBudget
                      ? "text-rose-600 dark:text-rose-400"
                      : nearBudget
                        ? "text-amber-700 dark:text-amber-400"
                        : "text-muted-foreground"
                  }
                >
                  {activeChars.toLocaleString()} / {maxChars.toLocaleString()}{" "}
                  chars ({pct}%)
                </span>
              </div>
              <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className={
                    overBudget
                      ? "h-full bg-rose-500"
                      : nearBudget
                        ? "h-full bg-amber-500"
                        : "h-full bg-primary"
                  }
                  style={{ width: `${pct}%` }}
                />
              </div>
              {overBudget && (
                <p className="text-[11px] text-rose-600 dark:text-rose-400">
                  Over the prompt cap — the oldest active lessons are silently
                  dropped from the AI prompt. Deactivate or delete stale ones,
                  or run the condense pass.
                </p>
              )}
              {nearBudget && (
                <p className="text-[11px] text-amber-700 dark:text-amber-400">
                  Near the prompt cap. Consider pruning inactive lessons.
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
            ) : lessons.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">
                No lessons saved for this customer yet.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[42%]">Lesson</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead className="whitespace-nowrap">Created</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-[1%]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lessons.map((l) => {
                    const isEditing = edit?.id === l.id;
                    return (
                      <TableRow
                        key={l.id}
                        className={l.active ? "" : "opacity-60"}
                        data-testid={`lesson-row-${l.id}`}
                      >
                        <TableCell className="align-top">
                          {isEditing ? (
                            <Textarea
                              value={edit.text}
                              onChange={(e) =>
                                setEdit({ id: l.id, text: e.target.value })
                              }
                              rows={4}
                              maxLength={1000}
                              className="text-xs font-mono"
                              data-testid={`lesson-edit-${l.id}`}
                            />
                          ) : (
                            <p className="text-xs whitespace-pre-wrap leading-relaxed">
                              {l.lessonText}
                            </p>
                          )}
                          <p className="text-[10px] font-mono text-muted-foreground mt-1">
                            {l.lessonText.length} chars
                            {l.createdByEmail ? ` · by ${l.createdByEmail}` : ""}
                          </p>
                        </TableCell>
                        <TableCell className="align-top">
                          {l.sourceMessageContent ? (
                            <div className="text-[11px] space-y-1">
                              <div className="flex items-center gap-1 text-muted-foreground">
                                <MessageSquare className="h-3 w-3" />
                                <span className="font-mono">
                                  {l.sourceWeekStart
                                    ? `week of ${l.sourceWeekStart}`
                                    : "chat message"}
                                </span>
                              </div>
                              <p className="text-muted-foreground italic line-clamp-4 whitespace-pre-wrap">
                                {l.sourceMessageContent}
                              </p>
                            </div>
                          ) : (
                            <span className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground">
                              {l.createdFromChatMessageId
                                ? "source removed"
                                : "manual / condensed"}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="align-top whitespace-nowrap">
                          <div className="font-mono text-[11px] text-muted-foreground">
                            {format(new Date(l.createdAt), "yyyy-MM-dd HH:mm")}
                          </div>
                          {l.updatedAt !== l.createdAt && (
                            <div className="font-mono text-[10px] text-muted-foreground">
                              edited{" "}
                              {format(new Date(l.updatedAt), "yyyy-MM-dd HH:mm")}
                              {l.updatedByEmail ? ` · ${l.updatedByEmail}` : ""}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="align-top">
                          {l.active ? (
                            <Badge className="font-mono">active</Badge>
                          ) : (
                            <Badge variant="outline" className="font-mono">
                              inactive
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="align-top">
                          <div className="flex flex-col items-end gap-1">
                            {isEditing ? (
                              <>
                                <Button
                                  size="sm"
                                  onClick={() => handleSaveText(l)}
                                  disabled={updateMut.isPending}
                                  data-testid={`lesson-save-${l.id}`}
                                >
                                  <Save className="h-3 w-3 mr-1" />
                                  Save
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => setEdit(null)}
                                >
                                  Cancel
                                </Button>
                              </>
                            ) : (
                              <>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() =>
                                    setEdit({ id: l.id, text: l.lessonText })
                                  }
                                  data-testid={`lesson-edit-button-${l.id}`}
                                >
                                  Edit text
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => handleToggleActive(l)}
                                  disabled={updateMut.isPending}
                                  data-testid={`lesson-toggle-${l.id}`}
                                >
                                  {l.active ? "Deactivate" : "Reactivate"}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => handleDelete(l)}
                                  disabled={deleteMut.isPending}
                                  title="Permanently delete"
                                  data-testid={`lesson-delete-${l.id}`}
                                >
                                  <Trash2 className="h-3 w-3 text-rose-600 dark:text-rose-400" />
                                </Button>
                              </>
                            )}
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
      </main>
    </div>
  );
}
