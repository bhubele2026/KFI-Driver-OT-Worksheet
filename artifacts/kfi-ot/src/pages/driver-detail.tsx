import React, { useState } from "react";
import { useLocation, useParams, Link } from "wouter";
import { 
  useGetDriverWeek,
  useCreateManualPunch,
  useEditPunch,
  useDeletePunch,
  useSetReviewed,
  getGetDriverWeekQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { Loader2, ArrowLeft, Plus, Edit2, Trash2, AlertCircle, Save, X } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";

export default function DriverDetail() {
  const params = useParams();
  const weekStart = params.weekStart!;
  const kfiId = params.kfiId!;
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const { data, isLoading, isError } = useGetDriverWeek(weekStart, kfiId);
  type Punch = NonNullable<typeof data>["punches"][number];

  const errMsg = (err: unknown, fallback: string) =>
    err instanceof Error ? err.message : fallback;
  const setReviewed = useSetReviewed();
  const createPunch = useCreateManualPunch();
  const editPunch = useEditPunch();
  const deletePunch = useDeletePunch();

  const KNOWN_CUSTOMERS = [
    "Adient",
    "Burnett",
    "DeLallo",
    "Greystone",
    "IWG",
    "LSI",
    "Penda",
    "Trienda",
    "Zenople",
  ];

  const [isManualModalOpen, setIsManualModalOpen] = useState(false);
  const [manualDate, setManualDate] = useState(weekStart);
  const [manualSource, setManualSource] = useState<"Driver" | "Customer">("Driver");
  const [manualCustomer, setManualCustomer] = useState<string>(
    data?.driver.customer && data.driver.customer !== "Unknown"
      ? data.driver.customer
      : KNOWN_CUSTOMERS[0],
  );
  const [manualClockIn, setManualClockIn] = useState("");
  const [manualClockOut, setManualClockOut] = useState("");

  const [editingPunchId, setEditingPunchId] = useState<number | null>(null);
  const [editClockIn, setEditClockIn] = useState("");
  const [editClockOut, setEditClockOut] = useState("");

  const toggleReviewed = () => {
    if (!data) return;
    setReviewed.mutate(
      { weekStart, kfiId, data: { reviewed: !data.reviewed } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetDriverWeekQueryKey(weekStart, kfiId) });
        }
      }
    );
  };

  const handleCreateManual = () => {
    if (!manualClockIn || !manualClockOut || !manualDate) {
      toast({ title: "Validation", description: "Date, Clock In, and Clock Out are required.", variant: "destructive" });
      return;
    }
    if (manualSource === "Customer" && !manualCustomer) {
      toast({ title: "Validation", description: "Pick a customer for a Customer-source punch.", variant: "destructive" });
      return;
    }
    createPunch.mutate(
      {
        weekStart,
        data: {
          kfiId,
          date: manualDate,
          source: manualSource,
          customer:
            manualSource === "Customer"
              ? manualCustomer
              : null,
          clockIn: manualClockIn,
          clockOut: manualClockOut,
        }
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetDriverWeekQueryKey(weekStart, kfiId) });
          setIsManualModalOpen(false);
          setManualClockIn("");
          setManualClockOut("");
          toast({ title: "Punch added" });
        },
        onError: (err) => {
          toast({ title: "Error", description: errMsg(err, "Failed to add punch"), variant: "destructive" });
        }
      }
    );
  };

  const startEdit = (p: Punch) => {
    setEditingPunchId(p.id);
    setEditClockIn(p.clockIn);
    setEditClockOut(p.clockOut);
  };

  const cancelEdit = () => {
    setEditingPunchId(null);
  };

  const saveEdit = (id: number) => {
    editPunch.mutate(
      { id, data: { clockIn: editClockIn, clockOut: editClockOut } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetDriverWeekQueryKey(weekStart, kfiId) });
          setEditingPunchId(null);
          toast({ title: "Punch updated" });
        },
        onError: (err) => {
          toast({ title: "Error", description: errMsg(err, "Failed to update punch"), variant: "destructive" });
        }
      }
    );
  };

  const handleDelete = (id: number) => {
    if (!confirm("Are you sure you want to delete this punch?")) return;
    deletePunch.mutate(
      { id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetDriverWeekQueryKey(weekStart, kfiId) });
          toast({ title: "Punch deleted" });
        },
        onError: (err) => {
          toast({ title: "Error", description: errMsg(err, "Failed to delete punch"), variant: "destructive" });
        }
      }
    );
  };

  if (isLoading) {
    return <div className="min-h-screen flex items-center justify-center"><Loader2 className="h-8 w-8 animate-spin" /></div>;
  }

  if (isError || !data) {
    return <div className="p-8 text-center text-destructive">Failed to load driver data.</div>;
  }

  // Group punches by date
  const punchesByDate = data.punches.reduce((acc, p) => {
    if (!acc[p.date]) acc[p.date] = [];
    acc[p.date].push(p);
    return acc;
  }, {} as Record<string, typeof data.punches>);

  const allDates = Array.from(new Set([...Object.keys(punchesByDate), ...data.dailyTotals.map(t => t.date)])).sort();

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background">
      <header className="sticky top-0 z-10 bg-sidebar text-sidebar-foreground border-b border-sidebar-border px-4 py-3 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-4">
          <Link href={`/weeks/${weekStart}`}>
            <Button variant="ghost" size="icon" className="h-8 w-8 text-sidebar-foreground hover:bg-sidebar-accent">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="h-4 w-px bg-sidebar-border" />
          <div>
            <h1 className="font-display font-bold text-lg tracking-tight leading-none">{data.driver.name}</h1>
            <p className="text-sm text-sidebar-foreground/90 mt-1 leading-none">
              <span className="font-medium">
                {data.driver.customer && data.driver.customer !== "Unknown"
                  ? data.driver.customer
                  : "Unassigned"}
              </span>
              <span className="text-sidebar-foreground/50 mx-2">·</span>
              <span className="font-mono text-xs text-sidebar-foreground/70">
                {data.driver.kfiId}
              </span>
            </p>
          </div>
        </div>
        <div className="flex items-center gap-6">
          <div className="flex items-center space-x-2 bg-sidebar-accent/50 px-3 py-1.5 rounded-md">
            <Checkbox id="reviewed" checked={data.reviewed} onCheckedChange={toggleReviewed} />
            <label htmlFor="reviewed" className="text-sm font-medium leading-none cursor-pointer">
              Reviewed
            </label>
          </div>
          <Button variant="secondary" size="sm" onClick={() => setIsManualModalOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Add Punch
          </Button>
        </div>
      </header>

      <main className="flex-1 p-6 max-w-7xl mx-auto w-full space-y-6">
        {data.checks.length > 0 && (
          <Card className="border-warning bg-warning/5">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm text-warning flex items-center gap-2">
                <AlertCircle className="h-4 w-4" /> Validation Alerts
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <ul className="space-y-1 text-sm text-warning-foreground">
                {data.checks.map((chk, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="font-mono text-xs opacity-70 w-24 shrink-0">{chk.date || "General"}</span>
                    <span>{chk.message}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <Card>
            <CardContent className="p-4 flex flex-col justify-center items-center">
              <span className="text-xs text-muted-foreground uppercase font-semibold">Driver</span>
              <span className="text-2xl font-bold font-mono text-blue-600 dark:text-blue-400">{data.totals.driverHours.toFixed(2)}</span>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex flex-col justify-center items-center">
              <span className="text-xs text-muted-foreground uppercase font-semibold">Customer</span>
              <span className="text-2xl font-bold font-mono text-emerald-600 dark:text-emerald-400">{data.totals.customerHours.toFixed(2)}</span>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex flex-col justify-center items-center">
              <span className="text-xs text-muted-foreground uppercase font-semibold">Total</span>
              <span className="text-2xl font-bold font-mono">{data.totals.totalHours.toFixed(2)}</span>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex flex-col justify-center items-center">
              <span className="text-xs text-muted-foreground uppercase font-semibold">Regular</span>
              <span className="text-2xl font-bold font-mono">{data.totals.regularHours.toFixed(2)}</span>
            </CardContent>
          </Card>
          <Card className="border-warning/50">
            <CardContent className="p-4 flex flex-col justify-center items-center">
              <span className="text-xs text-warning uppercase font-semibold">Overtime</span>
              <span className="text-2xl font-bold font-mono text-warning">{data.totals.overtimeHours.toFixed(2)}</span>
            </CardContent>
          </Card>
        </div>

        <Card>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[120px]">Date</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>In</TableHead>
                  <TableHead>Out</TableHead>
                  <TableHead className="text-right">Hours</TableHead>
                  <TableHead>Pay Type</TableHead>
                  <TableHead className="text-right w-[120px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {allDates.map(date => {
                  const dayPunches = punchesByDate[date] || [];
                  const dailyTotal = data.dailyTotals.find(t => t.date === date);
                  
                  return (
                    <React.Fragment key={date}>
                      {dayPunches.map(p => (
                        <TableRow key={p.id}>
                          <TableCell className="font-mono text-sm">{p.date}</TableCell>
                          <TableCell>
                            <Badge variant={p.source === "Driver" ? "default" : "secondary"} className={p.source === "Driver" ? "bg-blue-600 hover:bg-blue-700" : "bg-emerald-100 text-emerald-800 hover:bg-emerald-200 dark:bg-emerald-900/50 dark:text-emerald-300"}>
                              {p.source}
                            </Badge>
                            {p.isManual && <Badge variant="outline" className="ml-2 text-[10px] px-1 py-0 h-4">Manual</Badge>}
                            {p.edited && <Badge variant="outline" className="ml-2 text-[10px] px-1 py-0 h-4">Edited</Badge>}
                            {(p.updatedByEmail || p.createdByEmail) && (
                              <div
                                className="text-[10px] font-mono text-muted-foreground mt-0.5"
                                title={p.updatedAt ? new Date(p.updatedAt).toLocaleString() : ""}
                              >
                                {p.edited && p.updatedByEmail
                                  ? `edited by ${p.updatedByEmail}`
                                  : p.createdByEmail
                                    ? `by ${p.createdByEmail}`
                                    : ""}
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="font-mono">
                            {editingPunchId === p.id ? (
                              <Input className="h-8 w-24 font-mono text-sm" value={editClockIn} onChange={e => setEditClockIn(e.target.value)} />
                            ) : p.clockIn}
                          </TableCell>
                          <TableCell className="font-mono">
                            {editingPunchId === p.id ? (
                              <Input className="h-8 w-24 font-mono text-sm" value={editClockOut} onChange={e => setEditClockOut(e.target.value)} />
                            ) : p.clockOut}
                          </TableCell>
                          <TableCell className="text-right font-mono font-medium">{p.hours.toFixed(2)}</TableCell>
                          <TableCell className="text-muted-foreground text-sm">{p.payType || "-"}</TableCell>
                          <TableCell className="text-right">
                            {editingPunchId === p.id ? (
                              <div className="flex items-center justify-end gap-1">
                                <Button size="icon" variant="ghost" className="h-7 w-7 text-green-600" onClick={() => saveEdit(p.id)}><Save className="h-3 w-3" /></Button>
                                <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground" onClick={cancelEdit}><X className="h-3 w-3" /></Button>
                              </div>
                            ) : (
                              <div className="flex items-center justify-end gap-1">
                                <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-foreground" onClick={() => startEdit(p)}><Edit2 className="h-3 w-3" /></Button>
                                <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10" onClick={() => handleDelete(p.id)}><Trash2 className="h-3 w-3" /></Button>
                              </div>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                      {dailyTotal && dailyTotal.totalHours > 0 && (
                        <TableRow className="bg-muted/30 border-b-2 border-border/50">
                          <TableCell colSpan={4} className="text-right text-xs uppercase font-semibold text-muted-foreground tracking-wider py-2">
                            Daily Total
                          </TableCell>
                          <TableCell className="text-right font-mono font-bold py-2">{dailyTotal.totalHours.toFixed(2)}</TableCell>
                          <TableCell colSpan={2} className="py-2"></TableCell>
                        </TableRow>
                      )}
                    </React.Fragment>
                  );
                })}
                {allDates.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">No punches recorded for this week.</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </Card>
      </main>

      <Dialog open={isManualModalOpen} onOpenChange={setIsManualModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Manual Punch</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label>Date</Label>
              <Input type="date" value={manualDate} onChange={e => setManualDate(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label>Source</Label>
              <Select value={manualSource} onValueChange={(val) => setManualSource(val as "Driver" | "Customer")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Driver">Driver</SelectItem>
                  <SelectItem value="Customer">Customer</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {manualSource === "Customer" && (
              <div className="grid gap-2">
                <Label>Customer</Label>
                <Select value={manualCustomer} onValueChange={setManualCustomer}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {KNOWN_CUSTOMERS.map((c) => (
                      <SelectItem key={c} value={c}>{c}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label>Clock In</Label>
                <Input placeholder="7:30 AM" value={manualClockIn} onChange={e => setManualClockIn(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label>Clock Out</Label>
                <Input placeholder="3:45 PM" value={manualClockOut} onChange={e => setManualClockOut(e.target.value)} />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">Format as "H:MM AM/PM" (e.g. "8:00 AM")</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsManualModalOpen(false)}>Cancel</Button>
            <Button onClick={handleCreateManual} disabled={createPunch.isPending}>
              {createPunch.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Punch
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
