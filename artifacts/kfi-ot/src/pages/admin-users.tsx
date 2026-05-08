import { Fragment, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, Redirect } from "wouter";
import {
  useListUsers,
  useListInvites,
  useCreateInvite,
  useRevokeInvite,
  useUpdateUser,
  useCreatePasswordResetForUser,
  useResendInvite,
  useSendPasswordResetForUser,
  useGetMe,
  useGetMailerStatus,
  useListRateLimitBuckets,
  useListRateLimitEvents,
  useListRateLimitEventTimeseries,
  useListRateLimitEventTopOffenders,
  useClearRateLimitBucket,
  useListUserAuditLog,
  useAuditConnecteamTimeClocks,
  useListIpBlocklist,
  useAddIpBlocklist,
  useRemoveIpBlocklist,
  useListSuggestedIpBlocks,
  getListUsersQueryKey,
  getListInvitesQueryKey,
  getGetMailerStatusQueryKey,
  getListRateLimitBucketsQueryKey,
  getListRateLimitEventsQueryKey,
  getListRateLimitEventTimeseriesQueryKey,
  getListRateLimitEventTopOffendersQueryKey,
  getListUserAuditLogQueryKey,
  getAuditConnecteamTimeClocksQueryKey,
  getListIpBlocklistQueryKey,
  getListSuggestedIpBlocksQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Loader2,
  Lock,
  LockOpen,
  Mail,
  Power,
  PowerOff,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  KeyRound,
  Send,
  ShieldX,
  Sparkles,
  Trash2,
  Unlock,
} from "lucide-react";
import { format, parseISO } from "date-fns";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ipMatchesAny, isCidrEntry } from "@/lib/cidr";
import { Logo } from "@/components/logo";

function copy(text: string, toast: ReturnType<typeof useToast>["toast"]) {
  navigator.clipboard
    .writeText(text)
    .then(() => toast({ title: "Copied to clipboard" }))
    .catch(() =>
      toast({
        title: "Couldn't copy",
        description: "Copy the link manually.",
        variant: "destructive",
      }),
    );
}

export default function AdminUsers() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: me, isLoading: meLoading } = useGetMe();
  const { data: users, isLoading: usersLoading } = useListUsers({
    query: {
      enabled: !!me?.isAdmin,
      queryKey: getListUsersQueryKey(),
    },
  });
  const { data: invites, isLoading: invitesLoading } = useListInvites({
    query: {
      enabled: !!me?.isAdmin,
      queryKey: getListInvitesQueryKey(),
    },
  });
  const { data: mailerStatus } = useGetMailerStatus({
    query: {
      enabled: !!me?.isAdmin,
      queryKey: getGetMailerStatusQueryKey(),
    },
  });
  const [mailerWarningDismissed, setMailerWarningDismissed] = useState(false);
  const showMailerWarning =
    !!me?.isAdmin &&
    mailerStatus?.configured === false &&
    !mailerWarningDismissed;
  const { data: auditLog, isLoading: auditLoading } = useListUserAuditLog(
    { limit: 50 },
    {
      query: {
        enabled: !!me?.isAdmin,
        queryKey: getListUserAuditLogQueryKey({ limit: 50 }),
      },
    },
  );

  const { data: clocksAudit, isLoading: clocksLoading } =
    useAuditConnecteamTimeClocks({
      query: {
        enabled: !!me?.isAdmin,
        queryKey: getAuditConnecteamTimeClocksQueryKey(),
      },
    });

  const { data: rateLimitBuckets, isLoading: bucketsLoading } =
    useListRateLimitBuckets({
      query: {
        enabled: !!me?.isAdmin,
        queryKey: getListRateLimitBucketsQueryKey(),
        refetchInterval: 30_000,
      },
    });
  const { data: rateLimitEvents, isLoading: eventsLoading } =
    useListRateLimitEvents({
      query: {
        enabled: !!me?.isAdmin,
        queryKey: getListRateLimitEventsQueryKey(),
        refetchInterval: 60_000,
      },
    });
  const [pressureRangeDays, setPressureRangeDays] = useState<7 | 30 | 90>(7);
  const { data: rateLimitTimeseries, isLoading: timeseriesLoading } =
    useListRateLimitEventTimeseries(
      { days: pressureRangeDays },
      {
        query: {
          enabled: !!me?.isAdmin,
          queryKey: getListRateLimitEventTimeseriesQueryKey({
            days: pressureRangeDays,
          }),
          refetchInterval: 60_000,
        },
      },
    );
  const { data: rateLimitTopOffenders, isLoading: topOffendersLoading } =
    useListRateLimitEventTopOffenders(
      { days: 7, perDay: 3 },
      {
        query: {
          enabled: !!me?.isAdmin,
          queryKey: getListRateLimitEventTopOffendersQueryKey({
            days: 7,
            perDay: 3,
          }),
          refetchInterval: 60_000,
        },
      },
    );
  const [lockoutDayFilter, setLockoutDayFilter] = useState<string | null>(null);
  const clearBucket = useClearRateLimitBucket();

  const { data: ipBlocklist, isLoading: blocklistLoading } = useListIpBlocklist({
    query: {
      enabled: !!me?.isAdmin,
      queryKey: getListIpBlocklistQueryKey(),
      refetchInterval: 60_000,
    },
  });
  const addBlocklist = useAddIpBlocklist();
  const removeBlocklist = useRemoveIpBlocklist();
  const blocklistedEntries = (ipBlocklist ?? []).map((b) => b.ip);

  const { data: suggestedBlocks } = useListSuggestedIpBlocks({
    query: {
      enabled: !!me?.isAdmin,
      queryKey: getListSuggestedIpBlocksQueryKey(),
      refetchInterval: 60_000,
    },
  });
  const [dismissedSuggestions, setDismissedSuggestions] = useState<
    Record<string, string>
  >(() => {
    if (typeof window === "undefined") return {};
    try {
      const raw = window.localStorage.getItem(
        "kfi.dismissedIpSuggestions",
      );
      return raw ? (JSON.parse(raw) as Record<string, string>) : {};
    } catch {
      return {};
    }
  });
  const persistDismissed = (next: Record<string, string>) => {
    setDismissedSuggestions(next);
    try {
      window.localStorage.setItem(
        "kfi.dismissedIpSuggestions",
        JSON.stringify(next),
      );
    } catch {
      // Storage may be unavailable (private mode); the in-memory state is
      // still authoritative for this tab.
    }
  };
  const refetchSuggestions = () =>
    qc.invalidateQueries({ queryKey: getListSuggestedIpBlocksQueryKey() });
  const visibleSuggestions = (suggestedBlocks ?? []).filter(
    (s) => dismissedSuggestions[s.ip] !== s.lastBlockedAt,
  );

  const createInvite = useCreateInvite();
  const revokeInvite = useRevokeInvite();
  const resendInvite = useResendInvite();
  const updateUser = useUpdateUser();
  const createReset = useCreatePasswordResetForUser();
  const sendReset = useSendPasswordResetForUser();

  const [inviteEmail, setInviteEmail] = useState("");
  const [manualBlockIp, setManualBlockIp] = useState("");
  const [manualBlockReason, setManualBlockReason] = useState("");
  const [manualBlockError, setManualBlockError] = useState<string | null>(null);
  const [blockDialog, setBlockDialog] = useState<{
    open: boolean;
    ip: string;
    reason: string;
    error: string | null;
  }>({ open: false, ip: "", reason: "", error: null });
  const [latestInvite, setLatestInvite] = useState<string | null>(null);
  const [latestReset, setLatestReset] = useState<{
    email: string;
    url: string;
  } | null>(null);
  const [expandedUsers, setExpandedUsers] = useState<Set<number>>(new Set());
  // Per-row local override of the cooldown end time (epoch ms). Set when the
  // server returns 429 so the button immediately reflects the cooldown even
  // before the next /auth/invites or /auth/users refresh stamps lastSentAt.
  const [resendCooldownOverride, setResendCooldownOverride] = useState<
    Record<string, number>
  >({});
  const [resetCooldownOverride, setResetCooldownOverride] = useState<
    Record<number, number>
  >({});
  // 1Hz ticker so the "Try again in Ns" label counts down. We only mount this
  // page for admins viewing the table, so a per-second re-render is cheap.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // Mirror the server constant in artifacts/api-server/src/routes/auth.ts.
  const RESEND_COOLDOWN_MS = 60_000;
  const remainingSeconds = (
    lastSentAt: string | null | undefined,
    override: number | undefined,
  ): number => {
    const stampedEnd = lastSentAt
      ? new Date(lastSentAt).getTime() + RESEND_COOLDOWN_MS
      : 0;
    const end = Math.max(stampedEnd, override ?? 0);
    if (end <= now) return 0;
    return Math.max(1, Math.ceil((end - now) / 1000));
  };
  // Parse "...try again in N second(s)..." out of the 429 message; fall back
  // to the full cooldown if the message shape ever changes.
  const parseCooldownSeconds = (msg: string): number => {
    const m = /try again in (\d+)\s*second/i.exec(msg);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return Math.ceil(RESEND_COOLDOWN_MS / 1000);
  };

  const toggleExpanded = (id: number) => {
    setExpandedUsers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (!meLoading && me && !me.isAdmin) {
    return <Redirect to="/" />;
  }

  const refetchInvites = () =>
    qc.invalidateQueries({ queryKey: getListInvitesQueryKey() });
  const refetchUsers = () =>
    qc.invalidateQueries({ queryKey: getListUsersQueryKey() });
  const refetchBuckets = () =>
    qc.invalidateQueries({ queryKey: getListRateLimitBucketsQueryKey() });
  const refetchBlocklist = () =>
    qc.invalidateQueries({ queryKey: getListIpBlocklistQueryKey() });
  const refetchAudit = () =>
    qc.invalidateQueries({
      queryKey: [getListUserAuditLogQueryKey({ limit: 50 })[0]],
    });
  const refetchUserAudit = (targetUserId: number) =>
    qc.invalidateQueries({
      queryKey: getListUserAuditLogQueryKey({ targetUserId, limit: 100 }),
    });

  // Lenient IPv4 / IPv6 / CIDR client-side syntax check. The server is the
  // source of truth; this is only to catch obvious typos before the round
  // trip. Accepts: dotted-quad IPv4, colon-separated IPv6 (incl. `::`
  // shorthand), and either with an optional `/N` CIDR suffix.
  const looksLikeIpOrCidr = (raw: string): boolean => {
    const value = raw.trim();
    if (!value) return false;
    const [addr, mask, ...rest] = value.split("/");
    if (rest.length > 0) return false;
    if (mask !== undefined) {
      if (!/^\d+$/.test(mask)) return false;
      const n = Number(mask);
      if (!Number.isFinite(n) || n < 0) return false;
    }
    const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
    const m = ipv4.exec(addr);
    if (m) {
      if (mask !== undefined && Number(mask) > 32) return false;
      return m.slice(1).every((p) => {
        const n = Number(p);
        return n >= 0 && n <= 255 && String(n) === p;
      });
    }
    // IPv6: at least one colon, only hex digits / colons, allow `::`.
    if (addr.includes(":") && /^[0-9a-fA-F:]+$/.test(addr)) {
      if (mask !== undefined && Number(mask) > 128) return false;
      return true;
    }
    return false;
  };

  const handleManualBlockSubmit = (e: FormEvent) => {
    e.preventDefault();
    const ip = manualBlockIp.trim();
    if (!ip) {
      setManualBlockError("Enter an IP address or CIDR range.");
      return;
    }
    if (!looksLikeIpOrCidr(ip)) {
      setManualBlockError(
        "That doesn't look like a valid IP (e.g. 203.0.113.7) or CIDR range (e.g. 203.0.113.0/24).",
      );
      return;
    }
    setManualBlockError(null);
    const reason = manualBlockReason.trim() || null;
    addBlocklist.mutate(
      { data: { ip, reason } },
      {
        onSuccess: () => {
          refetchBlocklist();
          refetchSuggestions();
          setManualBlockIp("");
          setManualBlockReason("");
          toast({ title: "Blocked", description: ip });
        },
        onError: (err) => {
          const msg = err instanceof Error ? err.message : "Unknown error";
          toast({
            title: "Couldn't block IP",
            description: msg,
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleBlockIp = (ip: string, reasonHint: string) => {
    setBlockDialog({ open: true, ip, reason: reasonHint, error: null });
  };

  const submitBlockDialog = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = blockDialog.ip.trim();
    if (!trimmed) {
      setBlockDialog((prev) => ({
        ...prev,
        error: "Enter an IP address or CIDR range.",
      }));
      return;
    }
    if (!looksLikeIpOrCidr(trimmed)) {
      setBlockDialog((prev) => ({
        ...prev,
        error:
          "That doesn't look like a valid IP (e.g. 203.0.113.7) or CIDR range (e.g. 203.0.113.0/24).",
      }));
      return;
    }
    const reason = blockDialog.reason.trim() || null;
    addBlocklist.mutate(
      { data: { ip: trimmed, reason } },
      {
        onSuccess: () => {
          refetchBlocklist();
          refetchSuggestions();
          setBlockDialog({ open: false, ip: "", reason: "", error: null });
          toast({ title: "Blocked", description: trimmed });
        },
        onError: (err) => {
          const msg = err instanceof Error ? err.message : "Unknown error";
          setBlockDialog((prev) => ({ ...prev, error: msg }));
          toast({
            title: "Couldn't block IP",
            description: msg,
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleUnblockIp = (ip: string) => {
    removeBlocklist.mutate(
      { data: { ip } },
      {
        onSuccess: () => {
          refetchBlocklist();
          toast({ title: "IP unblocked", description: ip });
        },
        onError: (err) =>
          toast({
            title: "Couldn't unblock IP",
            description: err instanceof Error ? err.message : "Unknown error",
            variant: "destructive",
          }),
      },
    );
  };

  const handleClearBucket = (name: string, key: string) => {
    clearBucket.mutate(
      { name, key },
      {
        onSuccess: () => {
          refetchBuckets();
          toast({ title: "Lockout cleared", description: `${name} · ${key}` });
        },
        onError: (err) =>
          toast({
            title: "Couldn't clear lockout",
            description: err instanceof Error ? err.message : "Unknown error",
            variant: "destructive",
          }),
      },
    );
  };

  const formatBucketLabel = (name: string) => {
    switch (name) {
      case "login:ip":
        return "Failed sign-ins (per IP)";
      case "login:email":
        return "Failed sign-ins (per email)";
      case "auth:request-reset":
        return "Password-reset requests (per IP)";
      case "auth:token-submit":
        return "Token submissions (per IP)";
      case "auth:token-lookup":
        return "Token lookups (per IP)";
      default:
        return name;
    }
  };

  const formatTimeRemaining = (resetAtIso: string) => {
    const ms = new Date(resetAtIso).getTime() - Date.now();
    if (ms <= 0) return "expired";
    const totalSec = Math.ceil(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    if (m === 0) return `${s}s`;
    return `${m}m ${s.toString().padStart(2, "0")}s`;
  };

  const handleCreateInvite = (e: React.FormEvent) => {
    e.preventDefault();
    createInvite.mutate(
      { data: { email: inviteEmail } },
      {
        onSuccess: (data) => {
          setLatestInvite(data.acceptUrl);
          setInviteEmail("");
          refetchInvites();
          refetchAudit();
        },
        onError: (err) => {
          toast({
            title: "Couldn't create invite",
            description:
              err instanceof Error ? err.message : "Unknown error",
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleResendInvite = (token: string, email: string) => {
    resendInvite.mutate(
      { token },
      {
        onSuccess: () => {
          // Optimistically arm the cooldown so the button disables immediately;
          // the next /auth/invites refetch will replace this with the
          // server-stamped lastSentAt.
          setResendCooldownOverride((prev) => ({
            ...prev,
            [token]: Date.now() + RESEND_COOLDOWN_MS,
          }));
          refetchInvites();
          toast({
            title: "Invite re-sent",
            description: `Emailed the invite link to ${email}.`,
          });
        },
        onError: (err) => {
          const msg = err instanceof Error ? err.message : "Unknown error";
          const tooSoon = /already sent recently/i.test(msg);
          if (tooSoon) {
            const secs = parseCooldownSeconds(msg);
            setResendCooldownOverride((prev) => ({
              ...prev,
              [token]: Date.now() + secs * 1000,
            }));
            refetchInvites();
          }
          toast({
            title: tooSoon
              ? "Already sent recently"
              : /not configured/i.test(msg)
                ? "Email is not configured"
                : "Couldn't resend invite",
            description: tooSoon
              ? msg
              : /not configured/i.test(msg)
                ? "Ask the admin to set SMTP_HOST/SMTP_PORT. Copy the link instead."
                : msg,
            variant: tooSoon ? "default" : "destructive",
          });
        },
      },
    );
  };

  const handleSendReset = (id: number, email: string) => {
    sendReset.mutate(
      { id },
      {
        onSuccess: () => {
          // Optimistically arm the cooldown; refetchUsers() will replace this
          // with the server-stamped passwordResetLastSentAt.
          setResetCooldownOverride((prev) => ({
            ...prev,
            [id]: Date.now() + RESEND_COOLDOWN_MS,
          }));
          refetchUsers();
          toast({
            title: "Reset email sent",
            description: `Emailed a password-reset link to ${email}.`,
          });
        },
        onError: (err) => {
          const msg = err instanceof Error ? err.message : "Unknown error";
          const tooSoon = /already sent recently/i.test(msg);
          if (tooSoon) {
            const secs = parseCooldownSeconds(msg);
            setResetCooldownOverride((prev) => ({
              ...prev,
              [id]: Date.now() + secs * 1000,
            }));
            refetchUsers();
          }
          toast({
            title: tooSoon
              ? "Already sent recently"
              : /not configured/i.test(msg)
                ? "Email is not configured"
                : "Couldn't send reset email",
            description: tooSoon
              ? msg
              : /not configured/i.test(msg)
                ? "Ask the admin to set SMTP_HOST/SMTP_PORT, or use Generate link instead."
                : msg,
            variant: tooSoon ? "default" : "destructive",
          });
        },
      },
    );
  };

  const handleRevoke = (token: string) => {
    revokeInvite.mutate(
      { token },
      {
        onSuccess: () => {
          refetchInvites();
          refetchAudit();
          toast({ title: "Invite revoked" });
        },
      },
    );
  };

  const handleToggleActive = (id: number, isActive: boolean) => {
    updateUser.mutate(
      { id, data: { isActive: !isActive } },
      {
        onSuccess: () => {
          refetchUsers();
          refetchAudit();
          refetchUserAudit(id);
        },
        onError: (err) =>
          toast({
            title: "Update failed",
            description:
              err instanceof Error ? err.message : "Unknown error",
            variant: "destructive",
          }),
      },
    );
  };

  const handleUnlock = (id: number) => {
    updateUser.mutate(
      { id, data: { locked: false } },
      {
        onSuccess: () => {
          refetchUsers();
          toast({ title: "Account unlocked" });
        },
        onError: (err) =>
          toast({
            title: "Couldn't unlock account",
            description:
              err instanceof Error ? err.message : "Unknown error",
            variant: "destructive",
          }),
      },
    );
  };

  const handleToggleAdmin = (id: number, isAdmin: boolean) => {
    updateUser.mutate(
      { id, data: { isAdmin: !isAdmin } },
      {
        onSuccess: () => {
          refetchUsers();
          refetchAudit();
          refetchUserAudit(id);
        },
        onError: (err) =>
          toast({
            title: "Update failed",
            description:
              err instanceof Error ? err.message : "Unknown error",
            variant: "destructive",
          }),
      },
    );
  };

  const handleCreateReset = (id: number, email: string) => {
    createReset.mutate(
      { id },
      {
        onSuccess: (data) => {
          setLatestReset({ email, url: data.resetUrl });
          refetchAudit();
          refetchUserAudit(id);
        },
        onError: (err) =>
          toast({
            title: "Couldn't create reset link",
            description:
              err instanceof Error ? err.message : "Unknown error",
            variant: "destructive",
          }),
      },
    );
  };

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background">
      <header className="sticky top-0 z-10 bg-sidebar text-sidebar-foreground border-b border-sidebar-border px-4 h-14 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
          <Link href="/" title="KFI Staffing" className="no-underline"><Logo /></Link>
          <div className="h-5 w-px bg-sidebar-border/60" />
          <Link href="/">
            <Button
              variant="ghost"
              size="sm"
              className="text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground h-8"
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Button>
          </Link>
          <h1 className="font-display font-bold text-lg tracking-tight">
            Admin · Users
          </h1>
        </div>
        <div className="flex items-center gap-1">
          <Link href="/admin/ai-samples">
            <Button
              variant="ghost"
              size="sm"
              className="text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground h-8"
            >
              <Sparkles className="h-4 w-4 mr-2" />
              AI samples
            </Button>
          </Link>
          <Link href="/admin/customer-aliases">
            <Button
              variant="ghost"
              size="sm"
              className="text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground h-8"
            >
              Customer-driver mappings
            </Button>
          </Link>
          <Link href="/admin/parser-snoozes">
            <Button
              variant="ghost"
              size="sm"
              className="text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground h-8"
            >
              Parser snoozes
            </Button>
          </Link>
          <Link href="/admin/driver-id-aliases">
            <Button
              variant="ghost"
              size="sm"
              className="text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground h-8"
            >
              Driver-ID mappings
            </Button>
          </Link>
        </div>
      </header>

      <main className="flex-1 px-4 py-6 max-w-5xl w-full mx-auto space-y-6">
        {showMailerWarning && (
          <div
            role="alert"
            className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm flex items-start gap-3"
          >
            <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-600 dark:text-amber-400 shrink-0" />
            <div className="flex-1 space-y-1">
              <div className="font-semibold">
                Outgoing email is not configured.
              </div>
              <p className="text-xs text-muted-foreground">
                Invites and password resets will <strong>not</strong> be
                emailed — you'll need to copy and share the links manually.
                Set <code className="font-mono">SMTP_HOST</code>,{" "}
                <code className="font-mono">SMTP_PORT</code>,{" "}
                <code className="font-mono">SMTP_USER</code>,{" "}
                <code className="font-mono">SMTP_PASS</code>, and{" "}
                <code className="font-mono">MAIL_FROM</code> to enable email
                delivery.
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setMailerWarningDismissed(true)}
            >
              Dismiss
            </Button>
          </div>
        )}
        <Card>
          <CardHeader>
            <CardTitle className="font-display text-base flex items-center gap-2">
              <Mail className="h-4 w-4" />
              Invite a dispatcher
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <form
              onSubmit={handleCreateInvite}
              className="flex items-end gap-2"
            >
              <div className="flex-1 space-y-1">
                <label className="text-xs uppercase tracking-wider text-muted-foreground">
                  Email
                </label>
                <Input
                  type="email"
                  required
                  placeholder="new-dispatcher@kfi.com"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                />
              </div>
              <Button type="submit" disabled={createInvite.isPending}>
                {createInvite.isPending && (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                )}
                Generate invite
              </Button>
            </form>
            {latestInvite && (
              <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-xs space-y-2">
                <div className="font-semibold">
                  Share this link with the new dispatcher (valid for 7 days):
                </div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 font-mono break-all">
                    {latestInvite}
                  </code>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => copy(latestInvite, toast)}
                  >
                    <Copy className="h-3 w-3 mr-1" />
                    Copy
                  </Button>
                </div>
              </div>
            )}
            <div>
              <h3 className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
                Outstanding invites
              </h3>
              {invitesLoading ? (
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
              ) : invites && invites.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Email</TableHead>
                      <TableHead>Expires</TableHead>
                      <TableHead className="w-[1%]" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {invites.map((inv) => {
                      const resendRemaining = remainingSeconds(
                        inv.lastSentAt,
                        resendCooldownOverride[inv.token],
                      );
                      const onCooldown = resendRemaining > 0;
                      return (
                      <TableRow key={inv.id}>
                        <TableCell className="font-mono">{inv.email}</TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {format(new Date(inv.expiresAt), "yyyy-MM-dd HH:mm")}
                        </TableCell>
                        <TableCell className="flex gap-1 justify-end">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              handleResendInvite(inv.token, inv.email)
                            }
                            disabled={resendInvite.isPending || onCooldown}
                            title={
                              onCooldown
                                ? `You can resend this invite in ${resendRemaining}s`
                                : "Re-email this invite link to the recipient"
                            }
                          >
                            <Send className="h-3 w-3 mr-1" />
                            {onCooldown
                              ? `Try again in ${resendRemaining}s`
                              : "Resend"}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              copy(
                                `${window.location.origin}/accept-invite/${inv.token}`,
                                toast,
                              )
                            }
                          >
                            <Copy className="h-3 w-3 mr-1" />
                            Link
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => handleRevoke(inv.token)}
                            disabled={revokeInvite.isPending}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </TableCell>
                      </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-sm text-muted-foreground italic">
                  No outstanding invites.
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="font-display text-base flex items-center gap-2">
              <ShieldAlert className="h-4 w-4" />
              Security activity
            </CardTitle>
          </CardHeader>
          <CardContent>
            {visibleSuggestions.length > 0 && (
              <div className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
                <div className="flex items-start gap-2 mb-2">
                  <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <h4 className="font-display text-sm font-semibold text-amber-900 dark:text-amber-100">
                      Suggested blocks
                    </h4>
                    <p className="text-xs text-amber-900/80 dark:text-amber-100/80">
                      {visibleSuggestions.length === 1
                        ? "1 IP has"
                        : `${visibleSuggestions.length} IPs have`}{" "}
                      hit the lockout threshold 3+ times in the past 24 hours
                      and aren't blocklisted yet.
                    </p>
                  </div>
                </div>
                <ul className="space-y-1.5">
                  {visibleSuggestions.map((s) => (
                    <li
                      key={s.ip}
                      className="flex items-center gap-2 flex-wrap text-xs"
                    >
                      <span className="font-mono font-semibold break-all">
                        {s.ip}
                      </span>
                      <span className="font-mono text-amber-900/70 dark:text-amber-100/70">
                        {s.lockoutCount} lockouts · last{" "}
                        {format(new Date(s.lastBlockedAt), "MMM d, h:mm a")}
                      </span>
                      <span className="font-mono text-[10px] text-amber-900/60 dark:text-amber-100/60">
                        {s.limiters.join(", ")}
                      </span>
                      <span className="ml-auto flex gap-1">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            handleBlockIp(
                              s.ip,
                              `Auto-suggested: ${s.lockoutCount} lockouts in 24h (${s.limiters.join(", ")})`,
                            )
                          }
                          disabled={addBlocklist.isPending}
                          title="Add this IP to the blocklist"
                        >
                          <ShieldX className="h-3 w-3 mr-1" />
                          Block
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            persistDismissed({
                              ...dismissedSuggestions,
                              [s.ip]: s.lastBlockedAt,
                            })
                          }
                          title="Hide this suggestion until the IP triggers another lockout"
                        >
                          Dismiss
                        </Button>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="text-xs text-muted-foreground mb-3">
              Active rate-limit buckets (failed sign-ins, password-reset abuse,
              token guessing). Rows in red are currently blocked. Use the unlock
              button to clear a lockout for a specific account or IP.
            </p>
            {bucketsLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
            ) : rateLimitBuckets && rateLimitBuckets.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Limiter</TableHead>
                    <TableHead>Key</TableHead>
                    <TableHead className="text-right">Attempts</TableHead>
                    <TableHead>Resets in</TableHead>
                    <TableHead className="w-[1%]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rateLimitBuckets.map((b) => {
                    const id = `${b.name}::${b.key}`;
                    return (
                      <TableRow
                        key={id}
                        className={b.blocked ? "bg-rose-500/5" : undefined}
                      >
                        <TableCell className="text-xs">
                          <div className="font-medium">
                            {formatBucketLabel(b.name)}
                          </div>
                          <div className="font-mono text-[10px] text-muted-foreground">
                            {b.name}
                          </div>
                        </TableCell>
                        <TableCell className="font-mono text-xs break-all">
                          {b.key}
                        </TableCell>
                        <TableCell
                          className={`text-right font-mono text-xs ${b.blocked ? "text-rose-600 dark:text-rose-400 font-semibold" : ""}`}
                        >
                          {b.count}
                          {b.max > 0 ? ` / ${b.max}` : ""}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {formatTimeRemaining(b.resetAt)}
                        </TableCell>
                        <TableCell className="flex justify-end">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => handleClearBucket(b.name, b.key)}
                            disabled={clearBucket.isPending}
                            title="Clear this lockout"
                          >
                            <Unlock className="h-3 w-3 mr-1" />
                            Clear
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            ) : (
              <p className="text-sm text-muted-foreground italic">
                No active rate-limit buckets. Sign-ins and password-reset
                traffic look normal.
              </p>
            )}

            <div className="mt-6">
              <div className="flex items-start justify-between gap-3 mb-1">
                <h3 className="font-display text-sm font-semibold flex items-center gap-2">
                  <ShieldAlert className="h-3.5 w-3.5" />
                  Recent lockouts (last {pressureRangeDays} days)
                </h3>
                <div
                  className="inline-flex rounded-md border border-border/60 bg-muted/20 p-0.5"
                  role="group"
                  aria-label="Attack pressure window"
                >
                  {([7, 30, 90] as const).map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => {
                        setPressureRangeDays(d);
                        setLockoutDayFilter(null);
                      }}
                      className={`px-2 py-0.5 text-[11px] font-mono rounded-sm transition-colors ${
                        pressureRangeDays === d
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                      aria-pressed={pressureRangeDays === d}
                    >
                      {d}d
                    </button>
                  ))}
                </div>
              </div>
              <p className="text-xs text-muted-foreground mb-3">
                Each row is a (limiter, key) pair that has hit its threshold
                at least once in the selected window. Use the count to spot
                repeat offenders worth blocklisting at the network edge.
                Widen the window to spot slow brute-force campaigns.
              </p>

              <LockoutPressureChart
                isLoading={timeseriesLoading}
                points={rateLimitTimeseries ?? []}
                rangeDays={pressureRangeDays}
                selectedDay={lockoutDayFilter}
                onSelectDay={(day) =>
                  setLockoutDayFilter((prev) => (prev === day ? null : day))
                }
                formatLabel={formatBucketLabel}
              />

              {lockoutDayFilter && (
                <div className="mb-2 flex items-center justify-between gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-1.5 text-xs">
                  <span>
                    Showing lockouts active on{" "}
                    <span className="font-mono">
                      {format(parseISO(lockoutDayFilter), "MMM d, yyyy")}
                    </span>{" "}
                    (UTC).
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2"
                    onClick={() => setLockoutDayFilter(null)}
                  >
                    Clear
                  </Button>
                </div>
              )}

              {lockoutDayFilter && (() => {
                const offenders = (rateLimitTopOffenders ?? []).filter(
                  (o) => o.day === lockoutDayFilter,
                );
                if (topOffendersLoading) {
                  return (
                    <div className="mb-3 flex items-center gap-2 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs">
                      <Loader2 className="h-3 w-3 animate-spin text-primary" />
                      <span>Loading top offenders…</span>
                    </div>
                  );
                }
                if (offenders.length === 0) return null;
                return (
                  <div className="mb-3 rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
                    <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                      Top offenders on{" "}
                      {format(parseISO(lockoutDayFilter), "MMM d")}
                    </div>
                    <ol className="space-y-1.5">
                      {offenders.map((o, idx) => {
                        const liveBucket = (rateLimitBuckets ?? []).find(
                          (b) => b.name === o.name && b.key === o.key,
                        );
                        return (
                          <li
                            key={`${o.name}::${o.key}`}
                            className="flex items-center gap-2 text-xs"
                          >
                            <span className="font-mono text-muted-foreground w-4">
                              #{idx + 1}
                            </span>
                            <span className="font-mono font-semibold tabular-nums w-8">
                              {o.count}
                            </span>
                            <span className="text-muted-foreground">
                              {formatBucketLabel(o.name)}
                            </span>
                            <span className="font-mono break-all">
                              {o.key}
                            </span>
                            <span className="ml-auto flex items-center gap-1">
                              {liveBucket ? (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  className="h-6 px-2 text-[11px]"
                                  onClick={() =>
                                    handleClearBucket(o.name, o.key)
                                  }
                                  disabled={clearBucket.isPending}
                                  title="Clear this live lockout bucket"
                                >
                                  <Unlock className="h-3 w-3 mr-1" />
                                  Clear
                                </Button>
                              ) : null}
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="h-6 px-2 text-[11px]"
                                onClick={() => copy(o.key, toast)}
                                title="Copy the key (e.g. for blocklisting)"
                              >
                                <Copy className="h-3 w-3 mr-1" />
                                Copy key
                              </Button>
                            </span>
                          </li>
                        );
                      })}
                    </ol>
                  </div>
                );
              })()}

              {(() => {
                const filtered = filterEventsByDay(
                  rateLimitEvents ?? [],
                  lockoutDayFilter,
                );
                if (eventsLoading) {
                  return (
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  );
                }
                if (filtered.length === 0) {
                  return (
                    <p className="text-sm text-muted-foreground italic">
                      {lockoutDayFilter
                        ? "No lockouts active on the selected day."
                        : "No lockouts in the past 7 days."}
                    </p>
                  );
                }
                return (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Limiter</TableHead>
                        <TableHead>Key</TableHead>
                        <TableHead className="text-right">Lockouts</TableHead>
                        <TableHead>First</TableHead>
                        <TableHead>Most recent</TableHead>
                        <TableHead className="w-[1%]" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filtered.map((e) => {
                        const ip = e.key.startsWith("ip:")
                          ? e.key.slice(3)
                          : null;
                        const alreadyBlocked = ip
                          ? ipMatchesAny(ip, blocklistedEntries)
                          : false;
                        return (
                          <TableRow key={`${e.name}::${e.key}`}>
                            <TableCell className="text-xs">
                              <div className="font-medium">
                                {formatBucketLabel(e.name)}
                              </div>
                              <div className="font-mono text-[10px] text-muted-foreground">
                                {e.name}
                              </div>
                            </TableCell>
                            <TableCell className="font-mono text-xs break-all">
                              {e.key}
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs font-semibold">
                              {e.count}
                            </TableCell>
                            <TableCell className="font-mono text-xs text-muted-foreground whitespace-nowrap">
                              {format(new Date(e.firstBlockedAt), "MMM d, h:mm a")}
                            </TableCell>
                            <TableCell className="font-mono text-xs text-muted-foreground whitespace-nowrap">
                              {format(new Date(e.lastBlockedAt), "MMM d, h:mm a")}
                            </TableCell>
                            <TableCell className="flex justify-end">
                              {ip ? (
                                alreadyBlocked ? (
                                  <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider text-rose-700 dark:text-rose-300">
                                    <ShieldX className="h-3 w-3" />
                                    Blocked
                                  </span>
                                ) : (
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    onClick={() =>
                                      handleBlockIp(
                                        ip,
                                        `Repeat offender: ${e.count} lockouts on ${e.name}`,
                                      )
                                    }
                                    disabled={addBlocklist.isPending}
                                    title="Add this IP to the blocklist"
                                  >
                                    <ShieldX className="h-3 w-3 mr-1" />
                                    Block IP
                                  </Button>
                                )
                              ) : null}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                );
              })()}
            </div>

            <div className="mt-6">
              <h3 className="font-display text-sm font-semibold flex items-center gap-2 mb-1">
                <ShieldX className="h-3.5 w-3.5" />
                IP blocklist
              </h3>
              <p className="text-xs text-muted-foreground mb-3">
                Requests matching these addresses get a 403 before they reach
                the rate limiter. Entries can be a single IP (e.g.{" "}
                <code className="font-mono">203.0.113.7</code>) or a CIDR range
                (e.g. <code className="font-mono">203.0.113.0/24</code>) to
                cover a whole subnet. Use the Block button on a row above, or
                add one directly below — useful when an alert from another
                tool flags an IP before it hits our own lockouts.
              </p>
              <form
                onSubmit={handleManualBlockSubmit}
                className="mb-4 rounded-md border border-border/60 bg-muted/20 p-3"
              >
                <div className="flex flex-wrap items-start gap-2">
                  <div className="flex-1 min-w-[180px]">
                    <label
                      htmlFor="manual-block-ip"
                      className="block text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1"
                    >
                      IP or CIDR
                    </label>
                    <Input
                      id="manual-block-ip"
                      value={manualBlockIp}
                      onChange={(e) => {
                        setManualBlockIp(e.target.value);
                        if (manualBlockError) setManualBlockError(null);
                      }}
                      placeholder="203.0.113.7 or 203.0.113.0/24"
                      className="font-mono text-sm"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>
                  <div className="flex-[2] min-w-[200px]">
                    <label
                      htmlFor="manual-block-reason"
                      className="block text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1"
                    >
                      Reason (optional)
                    </label>
                    <Input
                      id="manual-block-reason"
                      value={manualBlockReason}
                      onChange={(e) => setManualBlockReason(e.target.value)}
                      placeholder="e.g. Cloudflare flagged scraping"
                      className="text-sm"
                      autoComplete="off"
                    />
                  </div>
                  <div className="self-end">
                    <Button
                      type="submit"
                      size="sm"
                      disabled={addBlocklist.isPending || !manualBlockIp.trim()}
                    >
                      <ShieldX className="h-3 w-3 mr-1" />
                      Add to blocklist
                    </Button>
                  </div>
                </div>
                {manualBlockError && (
                  <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">
                    {manualBlockError}
                  </p>
                )}
              </form>
              {blocklistLoading ? (
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
              ) : ipBlocklist && ipBlocklist.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>IP</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead>Blocked by</TableHead>
                      <TableHead>When</TableHead>
                      <TableHead className="w-[1%]" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ipBlocklist.map((b) => (
                      <TableRow key={b.ip}>
                        <TableCell className="font-mono text-xs break-all">
                          <span className="inline-flex items-center gap-2">
                            {b.ip}
                            {isCidrEntry(b.ip) && (
                              <span
                                className="rounded-sm bg-primary/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-primary"
                                title="CIDR range — blocks every address in this subnet"
                              >
                                Range
                              </span>
                            )}
                          </span>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {b.reason ?? "—"}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {b.createdByEmail ?? "—"}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground whitespace-nowrap">
                          {format(new Date(b.createdAt), "MMM d, h:mm a")}
                        </TableCell>
                        <TableCell className="flex justify-end">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => handleUnblockIp(b.ip)}
                            disabled={removeBlocklist.isPending}
                            title="Remove this IP from the blocklist"
                          >
                            <Unlock className="h-3 w-3 mr-1" />
                            Unblock
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-sm text-muted-foreground italic">
                  No IPs are currently blocklisted.
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="font-display text-base flex items-center gap-2">
              <Clock className="h-4 w-4" />
              Connecteam clocks
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground mb-3">
              Every time-clock discovered in the Connecteam account. Anything
              flagged "not pulled" won't show up in payroll refreshes until it's
              added to <code className="font-mono">TIME_CLOCKS</code>.
            </p>
            {clocksLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
            ) : !clocksAudit ? (
              <p className="text-sm text-muted-foreground italic">
                Couldn't load clocks audit.
              </p>
            ) : (
              <div className="space-y-3">
                {clocksAudit.missing.length > 0 && (
                  <div
                    role="alert"
                    className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-xs flex items-start gap-2"
                  >
                    <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-600 dark:text-amber-400 shrink-0" />
                    <div>
                      <div className="font-semibold">
                        {clocksAudit.missing.length} clock
                        {clocksAudit.missing.length === 1 ? "" : "s"} not pulled
                      </div>
                      <div className="text-muted-foreground">
                        Connecteam has clocks we aren't ingesting. Add their IDs
                        to <code className="font-mono">TIME_CLOCKS</code> if
                        their punches should land in payroll.
                      </div>
                    </div>
                  </div>
                )}
                {clocksAudit.configuredButMissingFromAccount.length > 0 && (
                  <div
                    role="alert"
                    className="rounded-md border border-rose-500/50 bg-rose-500/10 p-3 text-xs flex items-start gap-2"
                  >
                    <AlertTriangle className="h-4 w-4 mt-0.5 text-rose-600 dark:text-rose-400 shrink-0" />
                    <div>
                      <div className="font-semibold">
                        Stale config:{" "}
                        {clocksAudit.configuredButMissingFromAccount.join(", ")}
                      </div>
                      <div className="text-muted-foreground">
                        These clock IDs are in{" "}
                        <code className="font-mono">TIME_CLOCKS</code> but no
                        longer exist in the Connecteam account. Remove them to
                        avoid wasted refresh calls.
                      </div>
                    </div>
                  </div>
                )}
                {clocksAudit.discovered.length === 0 ? (
                  <p className="text-sm text-muted-foreground italic">
                    No clocks discovered in Connecteam.
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>ID</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Pulled?</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {clocksAudit.discovered.map((clock) => (
                        <TableRow key={clock.id}>
                          <TableCell className="text-sm">
                            {clock.name}
                          </TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">
                            {clock.id}
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {clock.isArchived ? (
                              <span className="text-muted-foreground">
                                ARCHIVED
                              </span>
                            ) : (
                              <span className="text-emerald-600 dark:text-emerald-400">
                                ACTIVE
                              </span>
                            )}
                          </TableCell>
                          <TableCell>
                            {clock.configured ? (
                              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
                                <CheckCircle2 className="h-3 w-3" />
                                Pulled
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider text-amber-700 dark:text-amber-300">
                                <AlertTriangle className="h-3 w-3" />
                                Not pulled
                              </span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="font-display text-base">
              Dispatcher accounts
            </CardTitle>
          </CardHeader>
          <CardContent>
            {latestReset && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs mb-4 space-y-2">
                <div className="font-semibold">
                  Password reset link for {latestReset.email} (valid for 1 hour):
                </div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 font-mono break-all">
                    {latestReset.url}
                  </code>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => copy(latestReset.url, toast)}
                  >
                    <Copy className="h-3 w-3 mr-1" />
                    Copy
                  </Button>
                </div>
              </div>
            )}
            {usersLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[1%]" />
                    <TableHead>Email</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Last sign-in</TableHead>
                    <TableHead className="w-[1%]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users?.map((u) => {
                    const isMe = me?.id === u.id;
                    const isLocked = !!u.lockedAt;
                    const isExpanded = expandedUsers.has(u.id);
                    return (
                      <Fragment key={u.id}>
                      <TableRow>
                        <TableCell className="pr-0">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 p-0"
                            onClick={() => toggleExpanded(u.id)}
                            aria-label={isExpanded ? "Hide history" : "Show history"}
                            aria-expanded={isExpanded}
                            title={isExpanded ? "Hide history" : "Show history"}
                          >
                            {isExpanded ? (
                              <ChevronDown className="h-4 w-4" />
                            ) : (
                              <ChevronRight className="h-4 w-4" />
                            )}
                          </Button>
                        </TableCell>
                        <TableCell className="font-mono">
                          {u.email}
                          {isMe && (
                            <span className="ml-2 text-[10px] uppercase text-muted-foreground">
                              (you)
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-1">
                            <span
                              className={`text-xs font-mono ${u.isAdmin ? "text-primary" : "text-muted-foreground"}`}
                            >
                              {u.isAdmin ? "ADMIN" : "DISPATCHER"}
                            </span>
                            <select
                              data-testid={`select-role-${u.id}`}
                              className="text-[11px] font-mono border border-border bg-background rounded px-1 py-0.5"
                              value={(u as { role?: string }).role ?? "reviewer"}
                              disabled={updateUser.isPending}
                              onChange={(e) => {
                                const role = e.target.value as
                                  | "reviewer"
                                  | "supervisor";
                                updateUser.mutate(
                                  { id: u.id, data: { role } },
                                  {
                                    onSuccess: () => {
                                      refetchUsers();
                                      refetchAudit();
                                      refetchUserAudit(u.id);
                                    },
                                    onError: (err) =>
                                      toast({
                                        title: "Couldn't update role",
                                        description:
                                          err instanceof Error
                                            ? err.message
                                            : "Unknown error",
                                        variant: "destructive",
                                      }),
                                  },
                                );
                              }}
                            >
                              <option value="reviewer">Reviewer</option>
                              <option value="supervisor">Supervisor</option>
                            </select>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-0.5">
                            <span
                              className={`text-xs font-mono ${u.isActive ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}
                            >
                              {u.isActive ? "ACTIVE" : "DEACTIVATED"}
                            </span>
                            {isLocked && (
                              <span
                                className="text-[10px] font-mono text-amber-600 dark:text-amber-400"
                                title={`Locked at ${format(new Date(u.lockedAt!), "yyyy-MM-dd HH:mm")}`}
                              >
                                LOCKED · {u.failedLoginCount} fails
                              </span>
                            )}
                            {!isLocked && u.failedLoginCount > 0 && (
                              <span className="text-[10px] font-mono text-muted-foreground">
                                {u.failedLoginCount} recent fails
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {u.lastLoginAt
                            ? format(new Date(u.lastLoginAt), "yyyy-MM-dd HH:mm")
                            : "—"}
                        </TableCell>
                        <TableCell className="flex gap-1 justify-end">
                          {isLocked && (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => handleUnlock(u.id)}
                              disabled={updateUser.isPending}
                              title="Unlock account"
                            >
                              <LockOpen className="h-3 w-3" />
                            </Button>
                          )}
                          {!isLocked && u.failedLoginCount > 0 && (
                            <span
                              className="inline-flex items-center text-muted-foreground"
                              title={`${u.failedLoginCount} consecutive failed sign-ins`}
                            >
                              <Lock className="h-3 w-3 opacity-30" />
                            </span>
                          )}
                          {(() => {
                            const sendResetRemaining = remainingSeconds(
                              u.passwordResetLastSentAt,
                              resetCooldownOverride[u.id],
                            );
                            const onCooldown = sendResetRemaining > 0;
                            return (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => handleSendReset(u.id, u.email)}
                                disabled={
                                  !u.isActive ||
                                  sendReset.isPending ||
                                  onCooldown
                                }
                                title={
                                  onCooldown
                                    ? `You can send another reset email in ${sendResetRemaining}s`
                                    : "Email a password-reset link to this user"
                                }
                              >
                                <Send className="h-3 w-3" />
                                {onCooldown && (
                                  <span className="ml-1 text-[10px]">
                                    Try again in {sendResetRemaining}s
                                  </span>
                                )}
                              </Button>
                            );
                          })()}
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              handleCreateReset(u.id, u.email)
                            }
                            disabled={!u.isActive || createReset.isPending}
                            title="Generate password-reset link"
                          >
                            <KeyRound className="h-3 w-3" />
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => handleToggleAdmin(u.id, u.isAdmin)}
                            disabled={isMe || updateUser.isPending}
                            title={u.isAdmin ? "Remove admin" : "Make admin"}
                          >
                            {u.isAdmin ? (
                              <ShieldOff className="h-3 w-3" />
                            ) : (
                              <ShieldCheck className="h-3 w-3" />
                            )}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant={u.isActive ? "destructive" : "outline"}
                            onClick={() => handleToggleActive(u.id, u.isActive)}
                            disabled={isMe || updateUser.isPending}
                            title={u.isActive ? "Deactivate" : "Reactivate"}
                          >
                            {u.isActive ? (
                              <PowerOff className="h-3 w-3" />
                            ) : (
                              <Power className="h-3 w-3" />
                            )}
                          </Button>
                        </TableCell>
                      </TableRow>
                      {isExpanded && (
                        <TableRow className="bg-muted/30 hover:bg-muted/30">
                          <TableCell />
                          <TableCell colSpan={5} className="py-3">
                            <UserAuditHistory userId={u.id} email={u.email} />
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
            <CardTitle className="font-display text-base">
              Recent activity
            </CardTitle>
          </CardHeader>
          <CardContent>
            {auditLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
            ) : auditLog && auditLog.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Target</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {auditLog.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="font-mono text-xs text-muted-foreground whitespace-nowrap">
                        {format(new Date(entry.createdAt), "yyyy-MM-dd HH:mm")}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {entry.actorEmail ?? "—"}
                      </TableCell>
                      <TableCell>
                        <span className="text-xs font-mono uppercase tracking-wider text-primary">
                          {entry.action}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs">
                        {entry.aiSample ? (
                          <span>
                            {entry.action === "pin-ai-extract-sample"
                              ? "Pinned AI sample "
                              : entry.action === "unpin-ai-extract-sample"
                                ? "Unpinned AI sample "
                                : "Deleted AI sample "}
                            <span className="font-mono">{entry.aiSample.fileName}</span>{" "}
                            <span className="text-muted-foreground">
                              ({entry.aiSample.customer}
                              {entry.aiSample.weekStart
                                ? `, week ${entry.aiSample.weekStart}`
                                : ""}
                              )
                            </span>
                          </span>
                        ) : renderParserSnoozeLabel(entry.action, entry.targetEmail) ?? (
                          <span className="font-mono">{entry.targetEmail ?? "—"}</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="text-sm text-muted-foreground italic">
                No admin activity recorded yet.
              </p>
            )}
          </CardContent>
        </Card>
      </main>

      <Dialog
        open={blockDialog.open}
        onOpenChange={(open) => {
          if (!open) {
            setBlockDialog({ open: false, ip: "", reason: "", error: null });
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Block IP from the API</DialogTitle>
            <DialogDescription>
              Enter a single IP (e.g.{" "}
              <code className="font-mono">203.0.113.7</code>) or a CIDR range
              (e.g. <code className="font-mono">203.0.113.0/24</code>) to cover
              the whole subnet.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submitBlockDialog} className="space-y-3">
            <div>
              <label
                htmlFor="block-dialog-ip"
                className="block text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1"
              >
                IP or CIDR
              </label>
              <Input
                id="block-dialog-ip"
                autoFocus
                value={blockDialog.ip}
                onChange={(e) =>
                  setBlockDialog((prev) => ({
                    ...prev,
                    ip: e.target.value,
                    error: null,
                  }))
                }
                placeholder="203.0.113.7 or 203.0.113.0/24"
                className="font-mono text-sm"
              />
            </div>
            <div>
              <label
                htmlFor="block-dialog-reason"
                className="block text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1"
              >
                Reason (optional)
              </label>
              <Input
                id="block-dialog-reason"
                value={blockDialog.reason}
                onChange={(e) =>
                  setBlockDialog((prev) => ({
                    ...prev,
                    reason: e.target.value,
                  }))
                }
                placeholder="Saved with the entry for later context"
                className="text-sm"
              />
            </div>
            {blockDialog.error && (
              <p className="text-xs text-rose-600 dark:text-rose-400">
                {blockDialog.error}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() =>
                  setBlockDialog({
                    open: false,
                    ip: "",
                    reason: "",
                    error: null,
                  })
                }
                disabled={addBlocklist.isPending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={addBlocklist.isPending || !blockDialog.ip.trim()}
              >
                {addBlocklist.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                ) : (
                  <ShieldX className="h-3.5 w-3.5 mr-1" />
                )}
                Block
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function UserAuditHistory({
  userId,
  email,
}: {
  userId: number;
  email: string;
}) {
  const { data, isLoading, isError } = useListUserAuditLog(
    { targetUserId: userId, limit: 100 },
    {
      query: {
        queryKey: getListUserAuditLogQueryKey({
          targetUserId: userId,
          limit: 100,
        }),
      },
    },
  );

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Loading history for {email}…
      </div>
    );
  }

  if (isError) {
    return (
      <p className="text-xs text-rose-600 dark:text-rose-400 italic">
        Couldn't load history for {email}.
      </p>
    );
  }

  if (!data || data.length === 0) {
    return (
      <p className="text-xs text-muted-foreground italic">
        No admin actions recorded for {email} yet.
      </p>
    );
  }

  return (
    <div className="space-y-1">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
        History for {email} · most recent first
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="h-8">When</TableHead>
            <TableHead className="h-8">Actor</TableHead>
            <TableHead className="h-8">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((entry) => (
            <TableRow key={entry.id}>
              <TableCell className="font-mono text-xs text-muted-foreground whitespace-nowrap py-1.5">
                {format(new Date(entry.createdAt), "yyyy-MM-dd HH:mm")}
              </TableCell>
              <TableCell className="font-mono text-xs py-1.5">
                {entry.actorEmail ?? "—"}
              </TableCell>
              <TableCell className="py-1.5">
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs font-mono uppercase tracking-wider text-primary">
                    {entry.action}
                  </span>
                  {(() => {
                    const label = renderParserSnoozeLabel(
                      entry.action,
                      entry.targetEmail,
                    );
                    return label ? (
                      <span className="text-xs text-muted-foreground">
                        {label}
                      </span>
                    ) : null;
                  })()}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function renderParserSnoozeLabel(
  action: string,
  targetEmail: string | null | undefined,
): ReactNode | null {
  if (action !== "parser-snooze" && action !== "parser-snooze-lift") {
    return null;
  }
  if (!targetEmail) return null;
  const rest = targetEmail.startsWith("parser-snooze:")
    ? targetEmail.slice("parser-snooze:".length)
    : targetEmail;
  const [customerRaw, ...metaParts] = rest.split("|");
  const customer = customerRaw || "(unknown customer)";
  if (action === "parser-snooze-lift") {
    return (
      <span>
        Resumed <span className="font-mono">{customer}</span> parser nudge
      </span>
    );
  }
  const untilPart = metaParts.find((m) => m.startsWith("until="));
  const untilValue = untilPart ? untilPart.slice("until=".length) : "";
  let untilLabel = "forever";
  if (untilValue && untilValue !== "forever") {
    try {
      untilLabel = `until ${format(parseISO(untilValue), "MMM d, yyyy")}`;
    } catch {
      untilLabel = `until ${untilValue}`;
    }
  }
  return (
    <span>
      Snoozed <span className="font-mono">{customer}</span> parser nudge{" "}
      {untilLabel}
    </span>
  );
}

const LIMITER_COLORS: Record<string, string> = {
  "login:ip": "hsl(var(--chart-1))",
  "login:email": "hsl(var(--chart-2))",
  "auth:request-reset": "hsl(var(--chart-4))",
  "auth:token-submit": "hsl(var(--chart-5))",
  "auth:token-lookup": "hsl(var(--chart-3))",
};

const FALLBACK_COLORS = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-4))",
  "hsl(var(--chart-5))",
  "hsl(var(--chart-3))",
];

function colorFor(name: string, index: number): string {
  return LIMITER_COLORS[name] ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length];
}

interface LockoutPressureChartProps {
  isLoading: boolean;
  points: { day: string; name: string; count: number }[];
  rangeDays: number;
  selectedDay: string | null;
  onSelectDay: (day: string) => void;
  formatLabel: (name: string) => string;
}

function LockoutPressureChart({
  isLoading,
  points,
  rangeDays,
  selectedDay,
  onSelectDay,
  formatLabel,
}: LockoutPressureChartProps) {
  const compactTicks = rangeDays > 14;
  if (isLoading) {
    return (
      <div className="mb-3 flex h-[160px] items-center justify-center rounded-md border border-border/50 bg-muted/20">
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
      </div>
    );
  }

  // Pivot the long-form rows into one record per day with a column per limiter.
  const dayMap = new Map<string, Record<string, number>>();
  const limiterNames: string[] = [];
  for (const p of points) {
    if (!dayMap.has(p.day)) dayMap.set(p.day, {});
    dayMap.get(p.day)![p.name] = p.count;
    if (!limiterNames.includes(p.name)) limiterNames.push(p.name);
  }
  const rows = Array.from(dayMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, byName]) => ({ day, ...byName }));

  const total = rows.reduce(
    (sum, r) =>
      sum +
      limiterNames.reduce(
        (s, n) => s + ((r as unknown as Record<string, number>)[n] ?? 0),
        0,
      ),
    0,
  );
  if (total === 0) {
    return (
      <div className="mb-3 rounded-md border border-dashed border-border/60 bg-muted/10 px-3 py-6 text-center text-xs italic text-muted-foreground">
        No lockouts in the past {rangeDays} days — nothing to chart.
      </div>
    );
  }

  return (
    <div className="mb-3">
      <div className="h-[180px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={rows}
            margin={{ top: 8, right: 12, bottom: 0, left: -16 }}
          >
            <CartesianGrid
              strokeDasharray="3 3"
              vertical={false}
              stroke="var(--border)"
            />
            <XAxis
              dataKey="day"
              tick={{ fontSize: 10 }}
              tickFormatter={(v: string) =>
                format(parseISO(v), compactTicks ? "M/d" : "EEE M/d")
              }
              interval={compactTicks ? "preserveStartEnd" : 0}
              minTickGap={compactTicks ? 12 : 4}
              stroke="var(--muted-foreground)"
            />
            <YAxis
              allowDecimals={false}
              tick={{ fontSize: 10 }}
              stroke="var(--muted-foreground)"
              width={32}
            />
            <Tooltip
              cursor={{ fill: "var(--muted)", opacity: 0.4 }}
              contentStyle={{
                fontSize: 11,
                background: "var(--popover)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                color: "var(--popover-foreground)",
              }}
              labelFormatter={(v: string) =>
                format(parseISO(v), "EEEE, MMM d, yyyy") + " (UTC)"
              }
              formatter={(value: number, name: string) => [
                value,
                formatLabel(name),
              ]}
            />
            <Legend
              iconType="square"
              wrapperStyle={{ fontSize: 10, paddingTop: 4 }}
              formatter={(v: string) => formatLabel(v)}
            />
            {limiterNames.map((name, i) => (
              <Bar
                key={name}
                dataKey={name}
                stackId="lockouts"
                fill={colorFor(name, i)}
                radius={
                  i === limiterNames.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]
                }
                onClick={(d: unknown) => {
                  const day = (d as { day?: string } | undefined)?.day;
                  if (day) onSelectDay(day);
                }}
                cursor="pointer"
                opacity={selectedDay ? 0.35 : 1}
                shape={(props: unknown) => {
                  const p = props as {
                    x: number;
                    y: number;
                    width: number;
                    height: number;
                    fill: string;
                    payload?: { day?: string };
                    radius?: number | [number, number, number, number];
                  };
                  const dimmed =
                    selectedDay != null && p.payload?.day !== selectedDay;
                  const r = Array.isArray(p.radius)
                    ? p.radius
                    : ([0, 0, 0, 0] as [number, number, number, number]);
                  const [tl, tr, br, bl] = r;
                  const path = roundedRectPath(
                    p.x,
                    p.y,
                    p.width,
                    p.height,
                    tl,
                    tr,
                    br,
                    bl,
                  );
                  return (
                    <path
                      d={path}
                      fill={p.fill}
                      opacity={dimmed ? 0.35 : 1}
                    />
                  );
                }}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-1 text-[10px] text-muted-foreground">
        Tip: click a bar to filter the table below to lockouts active on that
        day.
      </div>
    </div>
  );
}

function roundedRectPath(
  x: number,
  y: number,
  w: number,
  h: number,
  tl: number,
  tr: number,
  br: number,
  bl: number,
): string {
  if (w <= 0 || h <= 0) return "";
  const cap = Math.max(0, Math.min(w / 2, h / 2));
  const _tl = Math.min(tl, cap);
  const _tr = Math.min(tr, cap);
  const _br = Math.min(br, cap);
  const _bl = Math.min(bl, cap);
  return [
    `M${x + _tl},${y}`,
    `H${x + w - _tr}`,
    _tr ? `A${_tr},${_tr} 0 0 1 ${x + w},${y + _tr}` : "",
    `V${y + h - _br}`,
    _br ? `A${_br},${_br} 0 0 1 ${x + w - _br},${y + h}` : "",
    `H${x + _bl}`,
    _bl ? `A${_bl},${_bl} 0 0 1 ${x},${y + h - _bl}` : "",
    `V${y + _tl}`,
    _tl ? `A${_tl},${_tl} 0 0 1 ${x + _tl},${y}` : "",
    "Z",
  ].join(" ");
}

function utcDay(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

function filterEventsByDay<
  E extends { firstBlockedAt: string; lastBlockedAt: string },
>(events: E[], day: string | null): E[] {
  if (!day) return events;
  return events.filter((e) => {
    const first = utcDay(e.firstBlockedAt);
    const last = utcDay(e.lastBlockedAt);
    return first <= day && day <= last;
  });
}
