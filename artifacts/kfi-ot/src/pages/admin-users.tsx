import { useState } from "react";
import { Link, Redirect } from "wouter";
import {
  useListUsers,
  useListInvites,
  useCreateInvite,
  useRevokeInvite,
  useUpdateUser,
  useCreatePasswordResetForUser,
  useGetMe,
  getListUsersQueryKey,
  getListInvitesQueryKey,
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
  ArrowLeft,
  Copy,
  Loader2,
  Mail,
  Power,
  PowerOff,
  ShieldCheck,
  ShieldOff,
  KeyRound,
  Trash2,
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

  const createInvite = useCreateInvite();
  const revokeInvite = useRevokeInvite();
  const updateUser = useUpdateUser();
  const createReset = useCreatePasswordResetForUser();

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
                    <TableHead className="w-[1%]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users?.map((u) => {
                    const isMe = me?.id === u.id;
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
                          <span
                            className={`text-xs font-mono ${u.isActive ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}
                          >
                            {u.isActive ? "ACTIVE" : "DEACTIVATED"}
                          </span>
                        </TableCell>
                        <TableCell className="flex gap-1 justify-end">
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
