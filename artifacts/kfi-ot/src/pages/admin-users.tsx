import { Fragment, useState } from "react";
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
  useClearRateLimitBucket,
  useListUserAuditLog,
  useAuditConnecteamTimeClocks,
  useListIpBlocklist,
  useAddIpBlocklist,
  useRemoveIpBlocklist,
  getListUsersQueryKey,
  getListInvitesQueryKey,
  getGetMailerStatusQueryKey,
  getListRateLimitBucketsQueryKey,
  getListRateLimitEventsQueryKey,
  getListUserAuditLogQueryKey,
  getAuditConnecteamTimeClocksQueryKey,
  getListIpBlocklistQueryKey,
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
import { format } from "date-fns";

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
  const blocklistedSet = new Set((ipBlocklist ?? []).map((b) => b.ip));

  const createInvite = useCreateInvite();
  const revokeInvite = useRevokeInvite();
  const resendInvite = useResendInvite();
  const updateUser = useUpdateUser();
  const createReset = useCreatePasswordResetForUser();
  const sendReset = useSendPasswordResetForUser();

  const [inviteEmail, setInviteEmail] = useState("");
  const [latestInvite, setLatestInvite] = useState<string | null>(null);
  const [latestReset, setLatestReset] = useState<{
    email: string;
    url: string;
  } | null>(null);
  const [expandedUsers, setExpandedUsers] = useState<Set<number>>(new Set());

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

  const handleBlockIp = (ip: string, reasonHint: string) => {
    const reason = window.prompt(
      `Block this IP from the API?\n\n${ip}\n\nOptional reason (will be saved with the entry):`,
      reasonHint,
    );
    if (reason === null) return;
    addBlocklist.mutate(
      { data: { ip, reason: reason.trim() || null } },
      {
        onSuccess: () => {
          refetchBlocklist();
          toast({ title: "IP blocked", description: ip });
        },
        onError: (err) =>
          toast({
            title: "Couldn't block IP",
            description: err instanceof Error ? err.message : "Unknown error",
            variant: "destructive",
          }),
      },
    );
  };

  const handleUnblockIp = (ip: string) => {
    removeBlocklist.mutate(
      { ip },
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
          toast({
            title: "Invite re-sent",
            description: `Emailed the invite link to ${email}.`,
          });
        },
        onError: (err) => {
          const msg = err instanceof Error ? err.message : "Unknown error";
          const tooSoon = /already sent recently/i.test(msg);
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
          toast({
            title: "Reset email sent",
            description: `Emailed a password-reset link to ${email}.`,
          });
        },
        onError: (err) => {
          const msg = err instanceof Error ? err.message : "Unknown error";
          const tooSoon = /already sent recently/i.test(msg);
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
      <header className="sticky top-0 z-10 bg-sidebar text-sidebar-foreground border-b border-sidebar-border px-4 py-3 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
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
                    {invites.map((inv) => (
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
                            disabled={resendInvite.isPending}
                            title="Re-email this invite link to the recipient"
                          >
                            <Send className="h-3 w-3 mr-1" />
                            Resend
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
                    ))}
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
              <h3 className="font-display text-sm font-semibold flex items-center gap-2 mb-1">
                <ShieldAlert className="h-3.5 w-3.5" />
                Recent lockouts (last 7 days)
              </h3>
              <p className="text-xs text-muted-foreground mb-3">
                Each row is a (limiter, key) pair that has hit its threshold
                at least once in the past week. Use the count to spot repeat
                offenders worth blocklisting at the network edge.
              </p>
              {eventsLoading ? (
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
              ) : rateLimitEvents && rateLimitEvents.length > 0 ? (
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
                    {rateLimitEvents.map((e) => {
                      const ip = e.key.startsWith("ip:")
                        ? e.key.slice(3)
                        : null;
                      const alreadyBlocked = ip
                        ? blocklistedSet.has(ip)
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
              ) : (
                <p className="text-sm text-muted-foreground italic">
                  No lockouts in the past 7 days.
                </p>
              )}
            </div>

            <div className="mt-6">
              <h3 className="font-display text-sm font-semibold flex items-center gap-2 mb-1">
                <ShieldX className="h-3.5 w-3.5" />
                IP blocklist
              </h3>
              <p className="text-xs text-muted-foreground mb-3">
                Requests from these addresses get a 403 before they reach the
                rate limiter. Use the Block button on a row above to add a new
                entry, or remove one here when the heat dies down.
              </p>
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
                          {b.ip}
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
                          <span
                            className={`text-xs font-mono ${u.isAdmin ? "text-primary" : "text-muted-foreground"}`}
                          >
                            {u.isAdmin ? "ADMIN" : "DISPATCHER"}
                          </span>
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
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => handleSendReset(u.id, u.email)}
                            disabled={!u.isActive || sendReset.isPending}
                            title="Email a password-reset link to this user"
                          >
                            <Send className="h-3 w-3" />
                          </Button>
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
                      <TableCell className="font-mono text-xs">
                        {entry.targetEmail ?? "—"}
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
                <span className="text-xs font-mono uppercase tracking-wider text-primary">
                  {entry.action}
                </span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
