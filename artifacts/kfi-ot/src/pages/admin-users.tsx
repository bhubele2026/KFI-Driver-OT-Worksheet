import { useState } from "react";
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
  useClearRateLimitBucket,
  getListUsersQueryKey,
  getListInvitesQueryKey,
  getGetMailerStatusQueryKey,
  getListRateLimitBucketsQueryKey,
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

  const { data: rateLimitBuckets, isLoading: bucketsLoading } =
    useListRateLimitBuckets({
      query: {
        enabled: !!me?.isAdmin,
        queryKey: getListRateLimitBucketsQueryKey(),
        refetchInterval: 30_000,
      },
    });
  const clearBucket = useClearRateLimitBucket();

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

  if (!meLoading && me && !me.isAdmin) {
    return <Redirect to="/" />;
  }

  const refetchInvites = () =>
    qc.invalidateQueries({ queryKey: getListInvitesQueryKey() });
  const refetchUsers = () =>
    qc.invalidateQueries({ queryKey: getListUsersQueryKey() });
  const refetchBuckets = () =>
    qc.invalidateQueries({ queryKey: getListRateLimitBucketsQueryKey() });

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
          toast({
            title: /not configured/i.test(msg)
              ? "Email is not configured"
              : "Couldn't resend invite",
            description: /not configured/i.test(msg)
              ? "Ask the admin to set SMTP_HOST/SMTP_PORT. Copy the link instead."
              : msg,
            variant: "destructive",
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
          toast({
            title: /not configured/i.test(msg)
              ? "Email is not configured"
              : "Couldn't send reset email",
            description: /not configured/i.test(msg)
              ? "Ask the admin to set SMTP_HOST/SMTP_PORT, or use Generate link instead."
              : msg,
            variant: "destructive",
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
          toast({ title: "Invite revoked" });
        },
      },
    );
  };

  const handleToggleActive = (id: number, isActive: boolean) => {
    updateUser.mutate(
      { id, data: { isActive: !isActive } },
      {
        onSuccess: () => refetchUsers(),
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
        onSuccess: () => refetchUsers(),
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
                    return (
                      <TableRow key={u.id}>
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
