import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Loader2,
  Send,
  Sparkles,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Wrench,
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
  useStartCopilotConversation,
  useSendCopilotMessage,
  useGetCopilotConversation,
  useConfirmCopilotAction,
  useCancelCopilotAction,
  getGetCopilotConversationQueryKey,
} from "@workspace/api-client-react";
import type {
  CopilotMessage,
  CopilotToolStep,
  CopilotPendingAction,
} from "@workspace/api-client-react";

/**
 * Task #451: global "Worksheet Copilot" drawer. A single app-wide
 * assistant that can read and mutate the worksheet in plain language.
 * Mounted once in the app shell; a floating launcher opens it from any
 * page. The current route is parsed into a {weekStart, kfiId} context
 * that is forwarded to the backend so the assistant knows what the
 * dispatcher is looking at.
 */

function deriveContext(location: string): {
  weekStart: string | null;
  kfiId: string | null;
} {
  const driver = location.match(
    /^\/weeks\/(\d{4}-\d{2}-\d{2})\/drivers\/([^/]+)/,
  );
  if (driver) {
    return { weekStart: driver[1], kfiId: decodeURIComponent(driver[2]) };
  }
  const week = location.match(/^\/weeks\/(\d{4}-\d{2}-\d{2})/);
  if (week) {
    return { weekStart: week[1], kfiId: null };
  }
  return { weekStart: null, kfiId: null };
}

export function CopilotDrawer() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-5 right-5 z-50 h-12 rounded-full shadow-lg px-4 gap-2"
        data-testid="copilot-launcher"
      >
        <Sparkles className="h-4 w-4" />
        <span className="hidden sm:inline">Copilot</span>
      </Button>
      <CopilotSheet open={open} onOpenChange={setOpen} />
    </>
  );
}

function CopilotSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [location] = useLocation();
  const [input, setInput] = useState("");
  const [conversationId, setConversationId] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const context = useMemo(() => deriveContext(location), [location]);

  const conversationKey = getGetCopilotConversationQueryKey(
    conversationId ?? 0,
  );

  const { data: detail } = useGetCopilotConversation(conversationId ?? 0, {
    query: {
      enabled: open && conversationId != null,
      queryKey: conversationKey,
    },
  });

  // After any assistant turn that may have mutated the worksheet, refresh
  // every non-copilot query so the dashboard / driver page reflect the
  // change. Copilot conversation queries are re-fetched explicitly.
  const invalidateWorksheet = () => {
    void queryClient.invalidateQueries({
      predicate: (q) => {
        const key = q.queryKey?.[0];
        return typeof key === "string" && !key.includes("/copilot/");
      },
    });
  };

  const refetchConversation = () => {
    if (conversationId != null) {
      void queryClient.invalidateQueries({ queryKey: conversationKey });
    }
  };

  const startConversation = useStartCopilotConversation({
    mutation: {
      onSuccess: (res) => {
        setConversationId(res.conversation.id);
        invalidateWorksheet();
      },
    },
  });
  const sendMessage = useSendCopilotMessage({
    mutation: {
      onSuccess: () => {
        refetchConversation();
        invalidateWorksheet();
      },
    },
  });
  const confirmAction = useConfirmCopilotAction({
    mutation: {
      onSuccess: () => {
        refetchConversation();
        invalidateWorksheet();
      },
    },
  });
  const cancelAction = useCancelCopilotAction({
    mutation: {
      onSuccess: () => refetchConversation(),
    },
  });

  const messages = detail?.messages ?? [];
  const turnPending = startConversation.isPending || sendMessage.isPending;

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages.length, turnPending]);

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || turnPending) return;
    setInput("");
    const ctx = { weekStart: context.weekStart, kfiId: context.kfiId };
    if (conversationId == null) {
      startConversation.mutate({ data: { message: trimmed, context: ctx } });
    } else {
      sendMessage.mutate({
        id: conversationId,
        data: { message: trimmed, context: ctx },
      });
    }
  };

  const contextLabel = context.kfiId
    ? `Driver ${context.kfiId} · week of ${context.weekStart}`
    : context.weekStart
      ? `Week of ${context.weekStart}`
      : "All weeks";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-xl flex flex-col p-0"
        data-testid="copilot-drawer"
      >
        <SheetHeader className="p-4 border-b">
          <SheetTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" />
            Worksheet Copilot
          </SheetTitle>
          <SheetDescription className="flex items-center gap-2">
            <span>{contextLabel}</span>
            {conversationId != null && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => {
                  setConversationId(null);
                  setInput("");
                }}
                data-testid="copilot-new-conversation"
              >
                New chat
              </Button>
            )}
          </SheetDescription>
        </SheetHeader>

        <div
          ref={listRef}
          className="flex-1 overflow-y-auto p-4 space-y-3"
          data-testid="copilot-messages"
        >
          {messages.length === 0 && !turnPending && (
            <div className="text-sm text-muted-foreground italic">
              Ask the Copilot to read or change the worksheet — e.g. "Add an
              8-hour Tuesday for driver 412", "Scale Monday's hours by 1.5 for
              everyone at Adient", or "Mark all of this week's drivers
              reviewed".
            </div>
          )}
          {messages.map((m) => (
            <CopilotMessageRow
              key={m.id}
              message={m}
              onConfirm={() =>
                confirmAction.mutate({
                  id: m.conversationId,
                  messageId: m.id,
                })
              }
              onCancel={() =>
                cancelAction.mutate({
                  id: m.conversationId,
                  messageId: m.id,
                })
              }
              confirmPending={
                confirmAction.isPending &&
                confirmAction.variables?.messageId === m.id
              }
              cancelPending={
                cancelAction.isPending &&
                cancelAction.variables?.messageId === m.id
              }
            />
          ))}
          {turnPending && (
            <div
              className="flex justify-start"
              data-testid="copilot-thinking"
            >
              <div className="max-w-[85%] rounded-lg px-3 py-2 bg-muted text-xs text-muted-foreground italic flex items-center gap-2">
                <Loader2 className="h-3 w-3 animate-spin" /> Working…
              </div>
            </div>
          )}
          {(startConversation.isError || sendMessage.isError) && (
            <div className="text-sm text-destructive" data-testid="copilot-error">
              Something went wrong running that turn. Try again.
            </div>
          )}
        </div>

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
            placeholder="Ask the Copilot…"
            rows={2}
            className="resize-none text-sm"
            data-testid="copilot-input"
            disabled={turnPending}
          />
          <Button
            size="sm"
            onClick={handleSend}
            disabled={!input.trim() || turnPending}
            data-testid="copilot-send"
          >
            {turnPending ? (
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

function CopilotMessageRow(props: {
  message: CopilotMessage;
  onConfirm: () => void;
  onCancel: () => void;
  confirmPending: boolean;
  cancelPending: boolean;
}) {
  const { message: m, onConfirm, onCancel, confirmPending, cancelPending } =
    props;
  const isUser = m.role === "user";
  const toolSteps = m.toolSteps ?? [];
  const pending =
    m.actionStatus === "pending"
      ? (m.pendingAction as CopilotPendingAction | null | undefined)
      : null;

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 ${
          isUser ? "bg-primary text-primary-foreground" : "bg-muted"
        }`}
        data-testid={`copilot-message-${m.id}`}
      >
        {m.content && (
          <div className="text-sm whitespace-pre-wrap">{m.content}</div>
        )}
        {m.actionStatus === "cancelled" && (
          <div className="mt-1 text-xs text-muted-foreground italic">
            Action cancelled.
          </div>
        )}
        {m.actionStatus === "failed" && (
          <div className="mt-1 text-xs text-destructive">
            This action failed.
          </div>
        )}
        {!isUser && toolSteps.length > 0 && <ToolSteps steps={toolSteps} />}
        {pending && (
          <PendingActionCard
            action={pending}
            onConfirm={onConfirm}
            onCancel={onCancel}
            confirmPending={confirmPending}
            cancelPending={cancelPending}
          />
        )}
      </div>
    </div>
  );
}

function ToolSteps({ steps }: { steps: CopilotToolStep[] }) {
  const [open, setOpen] = useState(false);
  const failed = steps.filter((s) => !s.ok).length;
  return (
    <div className="mt-2" data-testid="copilot-tool-steps">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground hover:text-primary"
        data-testid="copilot-tool-steps-toggle"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        <Wrench className="h-3 w-3 shrink-0" />
        <span>
          {steps.length} step{steps.length === 1 ? "" : "s"}
          {failed > 0 ? ` · ${failed} failed` : ""}
        </span>
      </button>
      {open && (
        <ul className="mt-1.5 space-y-1">
          {steps.map((s, i) => (
            <li
              key={`${s.tool}-${i}`}
              className="flex items-start gap-1.5 text-xs"
            >
              {s.ok ? (
                <CheckCircle2 className="h-3 w-3 mt-0.5 text-emerald-600 shrink-0" />
              ) : (
                <XCircle className="h-3 w-3 mt-0.5 text-destructive shrink-0" />
              )}
              <span className="font-mono text-[10px]">{s.tool}</span>
              {s.summary && (
                <span className="text-muted-foreground">— {s.summary}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PendingActionCard(props: {
  action: CopilotPendingAction;
  onConfirm: () => void;
  onCancel: () => void;
  confirmPending: boolean;
  cancelPending: boolean;
}) {
  const { action, onConfirm, onCancel, confirmPending, cancelPending } = props;
  const busy = confirmPending || cancelPending;
  return (
    <div
      className="mt-2 rounded border bg-background text-foreground p-2 text-xs"
      data-testid="copilot-pending-action"
    >
      <div className="flex items-center gap-2 mb-1">
        <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
        <Badge variant="secondary" className="text-[10px]">
          {action.kind}
        </Badge>
        <span className="font-medium">{action.title}</span>
      </div>
      <ul className="mb-2 space-y-0.5">
        {action.summary.map((line, i) => (
          <li key={i} className="text-muted-foreground">
            {line}
          </li>
        ))}
      </ul>
      <ul className="mb-2 space-y-0.5">
        {action.calls.map((c, i) => (
          <li key={`${c.label}-${i}`} className="font-mono text-[10px]">
            {c.label}
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button
          size="sm"
          className="h-7 text-xs"
          disabled={busy}
          onClick={onConfirm}
          data-testid="copilot-confirm"
        >
          {confirmPending ? (
            <Loader2 className="h-3 w-3 animate-spin mr-1" />
          ) : (
            <CheckCircle2 className="h-3 w-3 mr-1" />
          )}
          Confirm
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          disabled={busy}
          onClick={onCancel}
          data-testid="copilot-cancel"
        >
          {cancelPending ? (
            <Loader2 className="h-3 w-3 animate-spin mr-1" />
          ) : (
            <XCircle className="h-3 w-3 mr-1" />
          )}
          Cancel
        </Button>
      </div>
    </div>
  );
}
