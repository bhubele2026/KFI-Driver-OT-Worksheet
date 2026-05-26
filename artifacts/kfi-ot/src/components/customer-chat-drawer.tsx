import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Loader2,
  Send,
  MessageSquare,
  CheckCircle2,
  X,
  ChevronDown,
  ChevronRight,
  FileText,
} from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  useGetCustomerUploadChat,
  usePostCustomerUploadChatMessage,
  useApplyCustomerUploadChatFix,
  useDismissCustomerUploadChatFix,
  getGetCustomerUploadChatQueryKey,
} from "@workspace/api-client-react";
import type {
  CustomerUploadChatMessage,
  ProposedFix,
  ChatFileEvidence,
} from "@workspace/api-client-react";

interface Props {
  weekStart: string;
  customer: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApplied?: () => void;
  /**
   * Task #408: when the drawer is opened from an upload-failure
   * affordance (preview dialog "Ask Claude", per-row error link,
   * bulk-item error link), the caller passes a pre-composed first
   * message that names the file and summarizes what went wrong so
   * the dispatcher only has to click Send. Seeded into the textarea
   * exactly once per open, and only when the input is still empty —
   * we never clobber an in-progress draft. The chat thread itself
   * is preserved across opens (same {week, customer} pair).
   */
  initialDraft?: string;
}

/**
 * Task #406: per-customer Claude chat drawer. Opens scoped to a single
 * {week, customer} and lets the dispatcher walk Claude through fixing
 * an "almost right" upload. Each assistant reply may include a
 * structured proposed fix the dispatcher can Apply or Dismiss inline.
 */
export function CustomerChatDrawer(props: Props) {
  const { weekStart, customer, open, onOpenChange, onApplied, initialDraft } =
    props;
  const queryClient = useQueryClient();
  const [input, setInput] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);
  // Task #408: seed `input` from `initialDraft` once per open, and only
  // when the textarea is still empty so we never clobber a dispatcher's
  // in-progress draft. Reset on close so the next open re-evaluates.
  const seededDraftRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open) {
      seededDraftRef.current = null;
      return;
    }
    if (!initialDraft) return;
    if (seededDraftRef.current === initialDraft) return;
    if (input.trim() !== "") return;
    setInput(initialDraft);
    seededDraftRef.current = initialDraft;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialDraft]);

  const threadKey = useMemo(
    () => getGetCustomerUploadChatQueryKey(weekStart, customer),
    [weekStart, customer],
  );
  const { data, isLoading, isError, error } = useGetCustomerUploadChat(
    weekStart,
    customer,
    { query: { enabled: open, queryKey: threadKey } },
  );

  const postMessage = usePostCustomerUploadChatMessage({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: threadKey });
      },
    },
  });
  const applyFix = useApplyCustomerUploadChatFix({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: threadKey });
        onApplied?.();
      },
    },
  });
  const dismissFix = useDismissCustomerUploadChatFix({
    mutation: {
      onSuccess: () =>
        void queryClient.invalidateQueries({ queryKey: threadKey }),
    },
  });

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [data?.messages.length]);

  const messages = data?.messages ?? [];
  const lessons = data?.lessons ?? [];
  const lockedKfiIds = data?.lockedKfiIds ?? [];

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || postMessage.isPending) return;
    setInput("");
    postMessage.mutate({
      weekStart,
      customer,
      data: { content: trimmed },
    });
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-xl flex flex-col p-0"
        data-testid="customer-chat-drawer"
      >
        <SheetHeader className="p-4 border-b">
          <SheetTitle className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4" />
            Fix upload · {customer}
          </SheetTitle>
          <SheetDescription>
            Week of {weekStart} ·{" "}
            {data ? `${data.customerPunchCount} punches in scope` : "…"}
            {data?.lastFileName ? ` · ${data.lastFileName}` : ""}
          </SheetDescription>
        </SheetHeader>

        {lockedKfiIds.length > 0 && (
          <div className="px-4 py-2 bg-amber-50 dark:bg-amber-950/30 border-b text-xs text-amber-900 dark:text-amber-200">
            {lockedKfiIds.length} driver-week
            {lockedKfiIds.length === 1 ? "" : "s"} locked — fixes touching
            them will be rejected with 423.
          </div>
        )}

        <div
          ref={listRef}
          className="flex-1 overflow-y-auto p-4 space-y-3"
          data-testid="customer-chat-messages"
        >
          {isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          )}
          {isError && (
            <div className="text-sm text-destructive">
              {error instanceof Error ? error.message : "Could not load chat."}
            </div>
          )}
          {!isLoading && messages.length === 0 && (
            <div className="text-sm text-muted-foreground italic">
              Ask Claude to fix something specific about this customer's
              upload — e.g. "Driver 412 is missing Tuesday" or "The name on
              the doc says J. Smith but it should be Jack Smith".
            </div>
          )}
          {messages.map((m) => (
            <ChatMessage
              key={m.id}
              message={m}
              onApply={(lessonText) =>
                applyFix.mutate({
                  weekStart,
                  customer,
                  messageId: m.id,
                  data: { lessonText: lessonText ?? null },
                })
              }
              onDismiss={() =>
                dismissFix.mutate({
                  weekStart,
                  customer,
                  messageId: m.id,
                })
              }
              applyPending={
                applyFix.isPending && applyFix.variables?.messageId === m.id
              }
              dismissPending={
                dismissFix.isPending &&
                dismissFix.variables?.messageId === m.id
              }
            />
          ))}
          {postMessage.isPending && (
            <div className="text-xs text-muted-foreground italic flex items-center gap-2">
              <Loader2 className="h-3 w-3 animate-spin" /> Claude is
              thinking…
            </div>
          )}
        </div>

        {lessons.length > 0 && (
          <div className="border-t px-4 py-2 max-h-32 overflow-y-auto">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
              Saved lessons for {customer}
            </div>
            <ul className="space-y-1">
              {lessons.map((l) => (
                <li
                  key={l.id}
                  className="text-xs text-muted-foreground flex items-start gap-1"
                >
                  <CheckCircle2 className="h-3 w-3 mt-0.5 text-emerald-600 shrink-0" />
                  <span>{l.lessonText}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="border-t p-3 flex gap-2 items-end">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="Ask Claude to fix something…"
            rows={2}
            className="resize-none text-sm"
            data-testid="customer-chat-input"
            disabled={postMessage.isPending}
          />
          <Button
            size="sm"
            onClick={handleSend}
            disabled={!input.trim() || postMessage.isPending}
            data-testid="customer-chat-send"
          >
            {postMessage.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function ChatMessage(props: {
  message: CustomerUploadChatMessage;
  onApply: (lessonText: string | null) => void;
  onDismiss: () => void;
  applyPending: boolean;
  dismissPending: boolean;
}) {
  const { message: m, onApply, onDismiss, applyPending, dismissPending } = props;
  const [lessonDraft, setLessonDraft] = useState(m.proposedLesson ?? "");
  useEffect(() => {
    setLessonDraft(m.proposedLesson ?? "");
  }, [m.proposedLesson]);

  const isUser = m.role === "user";
  const fix = m.proposedFix as ProposedFix | null;
  const evidence = (m.fileEvidence ?? null) as ChatFileEvidence | null;
  const resolved = !!m.appliedAt || !!m.dismissedAt;

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 ${
          isUser
            ? "bg-primary text-primary-foreground"
            : "bg-muted"
        }`}
        data-testid={`chat-message-${m.id}`}
      >
        <div className="text-sm whitespace-pre-wrap">{m.content}</div>
        {fix && !isUser && (
          <div
            className="mt-2 rounded border bg-background text-foreground p-2 text-xs"
            data-testid={`chat-proposed-fix-${m.id}`}
          >
            <div className="flex items-center gap-2 mb-1">
              <Badge variant="secondary" className="text-[10px]">
                {fix.kind}
              </Badge>
              {m.appliedAt && (
                <Badge
                  variant="outline"
                  className="text-[10px] text-emerald-700 border-emerald-300"
                >
                  Applied
                </Badge>
              )}
              {m.dismissedAt && (
                <Badge
                  variant="outline"
                  className="text-[10px] text-muted-foreground"
                >
                  Dismissed
                </Badge>
              )}
            </div>
            <pre className="font-mono text-[10px] whitespace-pre-wrap overflow-x-auto">
              {JSON.stringify(fix, null, 2)}
            </pre>
            {evidence && <FileEvidenceBlock evidence={evidence} />}
            {!resolved && (
              <div className="mt-2 space-y-2">
                <div>
                  <label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    Lesson to remember (optional)
                  </label>
                  <Textarea
                    value={lessonDraft}
                    onChange={(e) => setLessonDraft(e.target.value)}
                    rows={2}
                    className="text-xs resize-none mt-0.5"
                    data-testid={`chat-lesson-input-${m.id}`}
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    className="h-7 text-xs"
                    disabled={applyPending}
                    onClick={() => onApply(lessonDraft.trim() || null)}
                    data-testid={`chat-apply-${m.id}`}
                  >
                    {applyPending ? (
                      <Loader2 className="h-3 w-3 animate-spin mr-1" />
                    ) : (
                      <CheckCircle2 className="h-3 w-3 mr-1" />
                    )}
                    Apply
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs"
                    disabled={dismissPending}
                    onClick={onDismiss}
                    data-testid={`chat-dismiss-${m.id}`}
                  >
                    {dismissPending ? (
                      <Loader2 className="h-3 w-3 animate-spin mr-1" />
                    ) : (
                      <X className="h-3 w-3 mr-1" />
                    )}
                    Dismiss
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Task #420: collapsible "Evidence from file" block rendered beside
 * a proposed fix. Lists the rows the assistant pulled from the
 * uploaded customer file via `read_upload_file_rows` during the
 * turn — driver, date, in, out, hours — so the dispatcher can
 * sanity-check the proposal without re-opening the spreadsheet.
 * Defaults to open when the row count is small (≤3) since the
 * dispatcher almost always wants to glance at it; collapses
 * otherwise to keep long lists from dominating the chat.
 */
function FileEvidenceBlock({ evidence }: { evidence: ChatFileEvidence }) {
  const total = evidence.resolvedRows.length + evidence.pendingRows.length;
  const [open, setOpen] = useState(total <= 3);
  return (
    <div
      className="mt-2 rounded border border-dashed bg-muted/40 text-foreground p-2 text-xs"
      data-testid="chat-file-evidence"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 w-full text-left font-medium hover:text-primary"
        data-testid="chat-file-evidence-toggle"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        <FileText className="h-3 w-3 shrink-0" />
        <span>
          Evidence from file ({total} row{total === 1 ? "" : "s"})
        </span>
        <span className="ml-1 text-[10px] text-muted-foreground truncate">
          {evidence.fileName}
        </span>
      </button>
      {open && (
        <div className="mt-1.5 space-y-1.5">
          {evidence.resolvedRows.length > 0 && (
            <EvidenceTable
              caption="Matched to a driver"
              headers={["Driver", "Date", "In", "Out", "Hours"]}
              rows={evidence.resolvedRows.map((r) => [
                r.driverName ?? `kfiId ${r.kfiId}`,
                r.date,
                r.clockIn,
                r.clockOut,
                r.hours == null ? "—" : r.hours.toString(),
              ])}
              testId="chat-file-evidence-resolved"
            />
          )}
          {evidence.pendingRows.length > 0 && (
            <EvidenceTable
              caption="Name on doc — not yet aliased"
              headers={["Name on doc", "Date", "In", "Out", "Hours"]}
              rows={evidence.pendingRows.map((r) => [
                r.driverNameOnDoc,
                r.date,
                r.timeIn ?? "—",
                r.timeOut ?? "—",
                r.hours == null ? "—" : r.hours.toString(),
              ])}
              testId="chat-file-evidence-pending"
            />
          )}
        </div>
      )}
    </div>
  );
}

function EvidenceTable(props: {
  caption: string;
  headers: string[];
  rows: string[][];
  testId: string;
}) {
  return (
    <div data-testid={props.testId}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">
        {props.caption}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full font-mono text-[10px]">
          <thead>
            <tr className="text-muted-foreground">
              {props.headers.map((h) => (
                <th key={h} className="text-left font-normal pr-2 pb-0.5">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {props.rows.map((cells, i) => (
              <tr key={i}>
                {cells.map((c, j) => (
                  <td key={j} className="pr-2 align-top">
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
