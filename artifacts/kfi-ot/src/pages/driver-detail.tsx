import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useParams, Link } from "wouter";
import {
  useGetDriverWeek,
  useGetWeekSummary,
  useGetCustomerUploadStatus,
  useCreateManualPunch,
  useEditPunch,
  useDeletePunch,
  useSetPunchReviewed,
  useSetPunchFlagged,
  usePreviewPunch,
  previewPunch,
  useSetReviewed,
  useRefreshConnecteam,
  useRefreshConnecteamForDriver,
  useShiftDriverWeekPunches,
  useUpdateDriverTimezone,
  useUpsertCustomerTzPreference,
  useGetAllowedTimezones,
  useLockDriverWeek,
  useUnlockDriverWeek,
  useGetMe,
  useListCustomers,
  useListDriverNotes,
  useCreateDriverNote,
  useSoftDeleteDriverNote,
  useScaleDayHours,
  useResetDayHours,
  getGetDriverWeekQueryKey,
  getGetWeekSummaryQueryKey,
  getGetDriverWeekAuditQueryKey,
  getListDriverNotesQueryKey,
  useGetDriverPayrollProfile,
  useUpdateDriverPayrollProfile,
  getGetDriverPayrollProfileQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { Loader2, ArrowLeft, Plus, Edit2, Trash2, AlertCircle, AlertTriangle, Save, X, RefreshCw, Keyboard, Printer, Check as CheckIcon, Lock, LockOpen, ThumbsDown, Undo2, MessageSquarePlus, Globe, Flag } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Fragment } from "react";
import { ToastAction } from "@/components/ui/toast";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatPersonName } from "@/lib/format-name";
import { DriversSidebar, DriversSidebarMobileTrigger } from "@/components/drivers-sidebar";
import { ReviewedPill } from "@/components/reviewed-pill";
import {
  AllReviewedSplash,
  FullyReconciledSplash,
} from "@/components/all-reviewed-splash";
import {
  useAllReviewedCelebration,
  useFullyReconciledCelebration,
} from "@/hooks/use-all-reviewed-celebration";
import { Logo } from "@/components/logo";
import { LanguageToggle } from "@/components/language-toggle";
import { useTranslation } from "react-i18next";
import { useSidebarCollapsed } from "@/hooks/use-sidebar-collapsed";
import { useAutoAdvancePref } from "@/hooks/use-auto-advance";
import { useCelebrationSoundPref } from "@/hooks/use-celebration-sound";
import { PresenceChip } from "@/components/presence-chip";
import { EditingIndicator } from "@/components/editing-indicator";
import { useLiveUpdates } from "@/hooks/use-live-updates";
import { usePresence } from "@/hooks/use-presence";
import { useEditingLock } from "@/hooks/use-editing-lock";
import { PayrollProfileCard } from "@/components/payroll-profile-card";

const OT_THRESHOLD = 40;

const KNOWN_CUSTOMERS_FALLBACK = [
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

/** Parse "YYYY-MM-DD H:MM AM" into "MM/DD, h:MM AM" prefixed with the date. */
function formatClockCell(value: string): string {
  if (!value) return "";
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})\s+(.+)$/);
  if (!m) return value;
  const [, , mm, dd, time] = m;
  return `${mm}/${dd}, ${to12HourTime(time)}`;
}

/**
 * Tolerate both the canonical `h:MM AM/PM` shape and legacy
 * `HH:MM[:SS]` 24-hour rows already stored in the DB so historical
 * customer-file imports render consistently without a backfill.
 */
function to12HourTime(time: string): string {
  const s = time.trim();
  const m12 = s.match(/^(\d{1,2}):(\d{2})\s*([AaPp])\.?[Mm]\.?$/);
  if (m12) {
    const h = parseInt(m12[1], 10);
    return `${h}:${m12[2]} ${m12[3].toUpperCase()}M`;
  }
  const m24 = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (m24) {
    const hh = parseInt(m24[1], 10);
    const mm = m24[2];
    const ap = hh >= 12 ? "PM" : "AM";
    let h = hh % 12;
    if (h === 0) h = 12;
    return `${h}:${mm} ${ap}`;
  }
  return s;
}

/**
 * Mirror of `localStrToSortMs` from artifacts/api-server/src/lib/time.ts so the
 * client running-total split uses the same chronology as the server hours
 * engine. Returns a sortable ms value for "YYYY-MM-DD H:MM AM" /
 * "YYYY-MM-DD HH:MM:SS" wall-clock strings (the absolute value is meaningless;
 * order is correct within a single driver's display tz).
 */
function localStrToSortMs(str: string | null | undefined): number | null {
  if (!str) return null;
  if (str.includes("T") || /Z$/.test(str)) {
    const t = Date.parse(str);
    return isNaN(t) ? null : t;
  }
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d+):(\d+)(?::(\d+))?\s*([AP]M)?$/i);
  if (!m) return null;
  let hh = parseInt(m[4]);
  const mm = parseInt(m[5]);
  const ss = parseInt(m[6] ?? "0");
  const ap = (m[7] ?? "").toUpperCase();
  if (ap === "PM" && hh !== 12) hh += 12;
  if (ap === "AM" && hh === 12) hh = 0;
  return Date.UTC(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]), hh, mm, ss);
}

function isoDateToUtcMs(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function isCustomerNameUseful(name: string | null | undefined): boolean {
  if (!name) return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (trimmed === "Unknown") return false;
  if (trimmed.toLowerCase() === "[object object]") return false;
  if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2}(\d{2})?$|^\d{4}[/-]\d{1,2}[/-]\d{1,2}$/.test(trimmed)) return false;
  return true;
}

export default function DriverDetail() {
  const { t } = useTranslation();
  const params = useParams();
  const weekStart = params.weekStart!;
  const kfiId = params.kfiId!;
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading, isError } = useGetDriverWeek(weekStart, kfiId);
  const { data: weekSummary } = useGetWeekSummary(weekStart);
  const { data: me } = useGetMe();
  useLiveUpdates({
    weekStart,
    kfiId,
    selfEmail: me?.email ?? null,
    enableToasts: true,
  });
  const viewers = usePresence({ weekStart, kfiId });
  const { editorsForPunch, claim, release, touchActivity } = useEditingLock({
    weekStart,
    kfiId,
    selfEmail: me?.email ?? null,
  });
  const meRole = (me as { role?: string } | undefined)?.role;
  const canLock = !!me?.isAdmin || meRole === "supervisor";
  const lockMutation = useLockDriverWeek();
  const unlockMutation = useUnlockDriverWeek();
  const driverLocked = !!(data as { locked?: boolean } | undefined)?.locked;
  const driverStatus =
    ((data as { reviewStatus?: string } | undefined)?.reviewStatus ?? null) as
      | "good"
      | "bad"
      | null;

  const handleLockedError = (err: unknown, fallback: string) => {
    const msg = err instanceof Error ? err.message : fallback;
    if (/423|locked/i.test(msg)) {
      toast({
        title: "Driver-week is locked",
        description:
          "A supervisor has locked this driver-week. Unlock it to make changes.",
        variant: "destructive",
      });
      queryClient.invalidateQueries({
        queryKey: getGetDriverWeekQueryKey(weekStart, kfiId),
      });
      queryClient.invalidateQueries({
        queryKey: getGetWeekSummaryQueryKey(weekStart),
      });
      return;
    }
    toast({ title: "Error", description: msg, variant: "destructive" });
  };

  const refreshAfterLockChange = () => {
    queryClient.invalidateQueries({
      queryKey: getGetDriverWeekQueryKey(weekStart, kfiId),
    });
    queryClient.invalidateQueries({
      queryKey: getGetWeekSummaryQueryKey(weekStart),
    });
    queryClient.invalidateQueries({
      queryKey: getGetDriverWeekAuditQueryKey(weekStart, kfiId),
    });
  };

  const handleToggleLock = () => {
    if (!canLock) return;
    if (driverLocked) {
      unlockMutation.mutate(
        { weekStart, kfiId },
        {
          onSuccess: () => {
            refreshAfterLockChange();
            toast({ title: "Driver-week unlocked" });
          },
          onError: (err) =>
            toast({
              title: "Couldn't unlock",
              description: errMsg(err, "Unlock failed"),
              variant: "destructive",
            }),
        },
      );
    } else {
      lockMutation.mutate(
        { weekStart, kfiId },
        {
          onSuccess: () => {
            refreshAfterLockChange();
            toast({ title: "Driver-week locked" });
          },
          onError: (err) =>
            toast({
              title: "Couldn't lock",
              description: errMsg(err, "Lock failed"),
              variant: "destructive",
            }),
        },
      );
    }
  };

  const setStatus = (next: "good" | "bad" | null) => {
    setReviewed.mutate(
      { weekStart, kfiId, data: { status: next } },
      {
        onSuccess: () => {
          refreshAfterLockChange();
          if (next === "good" && autoAdvance) advanceToNextUnreviewed();
        },
        onError: (err) => handleLockedError(err, "Failed to update review"),
      },
    );
  };
  const [sidebarCollapsed, , toggleSidebar] = useSidebarCollapsed();
  const [autoAdvance, setAutoAdvance] = useAutoAdvancePref();
  const [celebrationSound, setCelebrationSound] = useCelebrationSoundPref();

  // Flat driver order matches the sidebar's grouping (customer -> drivers).
  const flatDriverIds = useMemo(() => {
    if (!weekSummary?.customers) return [] as string[];
    return weekSummary.customers.flatMap((g) => g.drivers.map((d) => d.kfiId));
  }, [weekSummary]);
  const flatDrivers = useMemo(() => {
    if (!weekSummary?.customers) return [] as { kfiId: string; reviewed: boolean }[];
    return weekSummary.customers.flatMap((g) =>
      g.drivers.map((d) => ({ kfiId: d.kfiId, reviewed: d.reviewed })),
    );
  }, [weekSummary]);
  const reviewedDriverCount = flatDrivers.filter((d) => d.reviewed).length;
  const { splashVisible: allReviewedSplashVisible, dismiss: dismissAllReviewedSplash } =
    useAllReviewedCelebration({
      weekStart,
      reviewed: reviewedDriverCount,
      total: flatDrivers.length,
      surface: "driver-detail",
    });

  // Mirror the week-summary calculation so the fully-reconciled
  // celebration can also fire on driver-detail — fixing the last
  // mismatch or reviewing the last driver from inside this page is
  // a perfectly normal way to cross the finish line. Kept inline (vs
  // a shared helper) because the inputs are already in-scope on both
  // surfaces and the logic is short.
  const { data: uploadStatusesForReconcile, isFetched: uploadStatusesFetched } =
    useGetCustomerUploadStatus(weekStart);
  const STALE_BASELINE_HOURS = 6;
  const allDriversForReconcile = useMemo(
    () => weekSummary?.customers.flatMap((c) => c.drivers) ?? [],
    [weekSummary],
  );
  const hasMismatchAlert = allDriversForReconcile.some((d) => {
    if (d.driverHours <= 0 || d.customerHours <= 0) return false;
    return Math.abs(d.driverHours - d.customerHours) > 0.05;
  });
  const hasParityDifferAlert = allDriversForReconcile.some(
    (d) => d.connecteamParity?.status === "differ",
  );
  const hasUnmappedAlert = (uploadStatusesForReconcile ?? []).some(
    (s) => (s.lastUnmappedIds?.length ?? 0) > 0,
  );
  const baselineStale = (() => {
    if (!weekSummary) return false;
    if (!weekSummary.lastRefreshedAt) return true;
    const ageMs = Date.now() - new Date(weekSummary.lastRefreshedAt).getTime();
    return ageMs > STALE_BASELINE_HOURS * 3_600_000;
  })();
  const fullyReconciled =
    allDriversForReconcile.length > 0 &&
    reviewedDriverCount >= allDriversForReconcile.length &&
    !hasMismatchAlert &&
    !hasParityDifferAlert &&
    !hasUnmappedAlert &&
    !baselineStale;
  const reconciliationReady =
    !!weekSummary &&
    allDriversForReconcile.length > 0 &&
    uploadStatusesFetched;
  const {
    splashVisible: fullyReconciledSplashVisible,
    dismiss: dismissFullyReconciledSplash,
  } = useFullyReconciledCelebration({
    weekStart,
    fullyReconciled,
    ready: reconciliationReady,
    surface: "driver-detail",
  });
  type Punch = NonNullable<typeof data>["punches"][number];
  type PreviewResult = Awaited<ReturnType<typeof previewPunch>>;

  const errMsg = (err: unknown, fallback: string) =>
    err instanceof Error ? err.message : fallback;
  const setReviewed = useSetReviewed();
  const createPunch = useCreateManualPunch();
  const editPunch = useEditPunch();
  const deletePunch = useDeletePunch();
  const setPunchReviewed = useSetPunchReviewed();
  const setPunchFlagged = useSetPunchFlagged();
  const refreshCt = useRefreshConnecteam();
  const refreshCtForDriver = useRefreshConnecteamForDriver();
  const shiftPunches = useShiftDriverWeekPunches();
  const updateDriverTz = useUpdateDriverTimezone();
  const upsertCustomerTz = useUpsertCustomerTzPreference();
  const { data: allowedTzs } = useGetAllowedTimezones();
  const [tzPopoverOpen, setTzPopoverOpen] = useState(false);
  const [tzDraft, setTzDraft] = useState<string>("__default__");
  const [shiftHours, setShiftHours] = useState<string>("1");
  // Per-customer tz popover: tracks which customer's badge is open plus the
  // local-only draft tz and shift-hours so two open popovers (this and the
  // driver-level one above) never clobber each other.
  const [openCustomerTz, setOpenCustomerTz] = useState<string | null>(null);
  const [customerTzDraft, setCustomerTzDraft] = useState<string>("__driver__");
  const [customerShiftHours, setCustomerShiftHours] = useState<string>("1");

  const handleRefresh = () => {
    refreshCt.mutate(
      { weekStart },
      {
        onSuccess: (res) => {
          queryClient.invalidateQueries({ queryKey: getGetDriverWeekQueryKey(weekStart, kfiId) });
          queryClient.invalidateQueries({ queryKey: getGetWeekSummaryQueryKey(weekStart) });
          toast({ title: t("weekSummary.refreshSuccessTitle"), description: t("weekSummary.refreshSuccessDesc", { drivers: res.driversFound, punches: res.punchesUpserted }) });
        },
        onError: (err) => handleLockedError(err, "Connecteam refresh failed"),
      },
    );
  };

  const [isManualModalOpen, setIsManualModalOpen] = useState(false);
  // Mirror manual-entry dialog open/close into editing claims so other
  // dispatchers can see "X is adding a punch" before the row exists.
  // punchId=null signals a not-yet-persisted draft (handled by
  // editorsForPunch(null)).
  useEffect(() => {
    if (!weekStart || !kfiId || !isManualModalOpen) return;
    claim(null);
    return () => {
      release(null);
    };
  }, [isManualModalOpen, weekStart, kfiId, claim, release]);
  const [manualDate, setManualDate] = useState(weekStart);
  const [manualSource, setManualSource] = useState<"Driver" | "Customer">("Driver");
  const [manualCustomer, setManualCustomer] = useState<string>(
    data?.driver.customer && data.driver.customer !== "Unknown"
      ? data.driver.customer
      : KNOWN_CUSTOMERS_FALLBACK[0],
  );
  const [manualClockIn, setManualClockIn] = useState("");
  const [manualClockOut, setManualClockOut] = useState("");

  // Pull the dispatcher-managed customer list for the manual-punch dropdown.
  // Falls back to the seed list while the request is in flight so the dialog
  // can render synchronously on first paint.
  const { data: customersData } = useListCustomers();
  const manualCustomerOptions = useMemo<string[]>(() => {
    const active = (customersData ?? [])
      .filter((c) => c.active)
      .map((c) => c.displayName);
    return active.length > 0 ? active : KNOWN_CUSTOMERS_FALLBACK;
  }, [customersData]);

  const [editingPunchId, setEditingPunchId] = useState<number | null>(null);
  const [editClockIn, setEditClockIn] = useState("");
  const [editClockOut, setEditClockOut] = useState("");
  const [editPreview, setEditPreview] = useState<PreviewResult | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // Inline day-total editor. `editingDay` is the YYYY-MM-DD of the day
  // whose total cell is open for edit. Saving proportionally scales the
  // contributing punches' hours so the day sum matches the new value.
  const [editingDay, setEditingDay] = useState<string | null>(null);
  const [editingDayValue, setEditingDayValue] = useState("");
  // Which punch row's Hours cell is currently rendering the day-total
  // editor. The edit affordance now lives on every punch row of a day; this
  // tracks which row to render the input/save/cancel controls on so the
  // editor only appears once even if a day has multiple punches.
  const [editingDayRowId, setEditingDayRowId] = useState<number | null>(null);
  const scaleDayHours = useScaleDayHours();
  const resetDayHours = useResetDayHours();

  // Notes ------------------------------------------------------------------
  const { data: notes } = useListDriverNotes(weekStart, kfiId);
  const createNote = useCreateDriverNote();
  const softDeleteNote = useSoftDeleteDriverNote();
  const [openNoteForPunch, setOpenNoteForPunch] = useState<number | null>(null);
  const [punchNoteDraft, setPunchNoteDraft] = useState("");
  const refreshNotes = () => {
    queryClient.invalidateQueries({
      queryKey: getListDriverNotesQueryKey(weekStart, kfiId),
    });
    queryClient.invalidateQueries({
      queryKey: getGetWeekSummaryQueryKey(weekStart),
    });
  };
  const submitNote = (body: string, punchId: number | null, onDone?: () => void) => {
    const trimmed = body.trim();
    if (!trimmed) return;
    createNote.mutate(
      { weekStart, kfiId, data: { body: trimmed, punchId } },
      {
        onSuccess: () => {
          refreshNotes();
          onDone?.();
        },
        onError: (err) =>
          toast({
            title: "Couldn't save note",
            description: errMsg(err, "Save failed"),
            variant: "destructive",
          }),
      },
    );
  };
  const handleSoftDeleteNote = (id: number) => {
    if (!confirm("Hide this note? The row is preserved for audit.")) return;
    softDeleteNote.mutate(
      { id },
      {
        onSuccess: () => {
          refreshNotes();
          toast({ title: "Note hidden" });
        },
        onError: (err) =>
          toast({
            title: "Couldn't hide note",
            description: errMsg(err, "Delete failed"),
            variant: "destructive",
          }),
      },
    );
  };
  type DriverNote = NonNullable<typeof notes>[number];
  const notesByPunch = useMemo(() => {
    const m = new Map<number, DriverNote[]>();
    for (const n of notes ?? []) {
      if (n.punchId == null) continue;
      const arr = m.get(n.punchId) ?? [];
      arr.push(n);
      m.set(n.punchId, arr);
    }
    return m;
  }, [notes]);

  // What the server thinks the punch list will look like once we save the
  // dialog draft. Recomputed via `/preview-punch` whenever any input changes
  // (debounced) so the dispatcher sees the same RT/OT split they'll get
  // post-save. `null` means "not yet computed for the current inputs".
  const [dialogPreview, setDialogPreview] = useState<PreviewResult | null>(null);
  const previewMutation = usePreviewPunch();

  // Debounce raw preview calls so a fast typist doesn't spam the API. Each
  // call carries a monotonically-increasing seq so an out-of-order response
  // can't clobber a fresher result.
  const previewSeq = useRef(0);
  const runPreview = (
    args: {
      kfiId: string;
      source: "Driver" | "Customer";
      customer: string | null;
      date: string;
      clockIn: string;
      clockOut: string;
      excludePunchId: number | null;
    },
    onResult: (r: PreviewResult | null) => void,
  ) => {
    if (!args.kfiId || !args.date || !args.clockIn || !args.clockOut) {
      onResult(null);
      return;
    }
    const seq = ++previewSeq.current;
    previewMutation.mutate(
      { weekStart, data: args },
      {
        onSuccess: (r) => {
          if (seq === previewSeq.current) onResult(r);
        },
        onError: () => {
          if (seq === previewSeq.current) onResult(null);
        },
      },
    );
  };

  useEffect(() => {
    if (!isManualModalOpen) {
      setDialogPreview(null);
      return;
    }
    // CRITICAL: invalidate the previous preview synchronously the moment any
    // input changes, so the Save button (gated on `dialogPreview !== null`)
    // disables instantly and the dispatcher cannot submit a stale draft
    // before the debounced refresh lands.
    setDialogPreview(null);
    // Bump the seq even before the debounced call fires so any in-flight
    // request from the previous keystroke is dropped on arrival.
    previewSeq.current += 1;
    const handle = setTimeout(() => {
      runPreview(
        {
          kfiId,
          source: manualSource,
          customer: manualSource === "Customer" ? manualCustomer : null,
          date: manualDate,
          clockIn: manualClockIn,
          clockOut: manualClockOut,
          excludePunchId: null,
        },
        setDialogPreview,
      );
    }, 250);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isManualModalOpen,
    kfiId,
    manualSource,
    manualCustomer,
    manualDate,
    manualClockIn,
    manualClockOut,
  ]);

  useEffect(() => {
    if (editingPunchId === null) {
      setEditPreview(null);
      return;
    }
    const p = data?.punches.find((x) => x.id === editingPunchId);
    if (!p) return;
    // Same gating discipline as the dialog: drop the stale preview the
    // instant any input changes so the inline-edit row never shows totals
    // for the previous keystroke.
    setEditPreview(null);
    previewSeq.current += 1;
    const handle = setTimeout(() => {
      runPreview(
        {
          kfiId,
          source: p.source,
          customer: p.customer ?? null,
          date: p.date,
          clockIn: editClockIn,
          clockOut: editClockOut,
          excludePunchId: p.id,
        },
        setEditPreview,
      );
    }, 250);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingPunchId, editClockIn, editClockOut]);

  // Keyboard shortcuts: j/ArrowDown = next driver, k/ArrowUp = previous driver,
  // r = toggle reviewed, ? = show help. Skipped while typing in inputs/textareas
  // or while the Add Punch dialog is open.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          target.isContentEditable
        ) {
          return;
        }
      }
      if (isManualModalOpen) return;
      // Don't fight an open Radix dialog elsewhere on the page.
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;

      const key = e.key;
      if (key === "?" ) {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
        return;
      }
      if (key === "Escape" && shortcutsOpen) {
        setShortcutsOpen(false);
        return;
      }

      if (key === "j" || key === "ArrowDown") {
        if (flatDriverIds.length === 0) return;
        e.preventDefault();
        const idx = flatDriverIds.indexOf(kfiId);
        const next = flatDriverIds[(idx === -1 ? 0 : idx + 1) % flatDriverIds.length];
        setLocation(`/weeks/${weekStart}/drivers/${next}`);
        return;
      }
      if (key === "k" || key === "ArrowUp") {
        if (flatDriverIds.length === 0) return;
        e.preventDefault();
        const idx = flatDriverIds.indexOf(kfiId);
        const len = flatDriverIds.length;
        const prev = flatDriverIds[(idx === -1 ? 0 : (idx - 1 + len) % len)];
        setLocation(`/weeks/${weekStart}/drivers/${prev}`);
        return;
      }
      if (key === "n" || key === "N" || key === "p" || key === "P") {
        if (flatDrivers.length === 0) return;
        e.preventDefault();
        const forward = key === "n" || key === "N";
        const len = flatDrivers.length;
        const startIdx = flatDrivers.findIndex((d) => d.kfiId === kfiId);
        const base = startIdx === -1 ? (forward ? -1 : 0) : startIdx;
        let target: string | null = null;
        for (let step = 1; step <= len; step++) {
          const probe = ((base + (forward ? step : -step)) % len + len) % len;
          if (!flatDrivers[probe].reviewed) {
            target = flatDrivers[probe].kfiId;
            break;
          }
        }
        if (!target) {
          toast({ title: "All drivers reviewed for this week" });
          return;
        }
        setLocation(`/weeks/${weekStart}/drivers/${target}`);
        return;
      }
      if (key === "r" || key === "R") {
        if (!data) return;
        e.preventDefault();
        const newVal = !data.reviewed;
        setReviewed.mutate(
          { weekStart, kfiId, data: { reviewed: newVal } },
          {
            onSuccess: () => {
              queryClient.invalidateQueries({ queryKey: getGetDriverWeekQueryKey(weekStart, kfiId) });
              queryClient.invalidateQueries({ queryKey: getGetWeekSummaryQueryKey(weekStart) });
              if (newVal && autoAdvance) advanceToNextUnreviewed();
            },
          },
        );
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    flatDriverIds,
    flatDrivers,
    kfiId,
    weekStart,
    setLocation,
    isManualModalOpen,
    shortcutsOpen,
    data,
    setReviewed,
    queryClient,
    toast,
    autoAdvance,
  ]);

  // Find the next unreviewed driver after the current one in sidebar order,
  // skipping the current driver (which we've just toggled to reviewed). The
  // weekSummary cache may still report the current driver as un-reviewed
  // because the invalidation hasn't refetched yet, so we exclude it
  // explicitly. Returns null if every other driver is already reviewed.
  const findNextUnreviewedAfter = (currentId: string): string | null => {
    if (flatDrivers.length === 0) return null;
    const len = flatDrivers.length;
    const startIdx = flatDrivers.findIndex((d) => d.kfiId === currentId);
    const base = startIdx === -1 ? -1 : startIdx;
    for (let step = 1; step <= len; step++) {
      const probe = (((base + step) % len) + len) % len;
      const d = flatDrivers[probe];
      if (d.kfiId === currentId) continue;
      if (!d.reviewed) return d.kfiId;
    }
    return null;
  };

  const advanceToNextUnreviewed = () => {
    const next = findNextUnreviewedAfter(kfiId);
    if (next) {
      setLocation(`/weeks/${weekStart}/drivers/${next}`);
    } else {
      toast({ title: "All drivers reviewed for this week" });
    }
  };

  const toggleReviewed = () => {
    if (!data) return;
    const newVal = !data.reviewed;
    setReviewed.mutate(
      { weekStart, kfiId, data: { reviewed: newVal } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetDriverWeekQueryKey(weekStart, kfiId) });
          queryClient.invalidateQueries({ queryKey: getGetWeekSummaryQueryKey(weekStart) });
          if (newVal && autoAdvance) advanceToNextUnreviewed();
        },
      },
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
    // Fail-safe: never submit before the dispatcher has seen a valid preview.
    // The Save button is also disabled in this state, but a stale/loading
    // preview could still race a fast double-click.
    if (!dialogPreview || !dialogPreview.valid) {
      toast({
        title: "Preview not ready",
        description: dialogPreview?.invalidReason || "Wait for the preview to load before saving.",
        variant: "destructive",
      });
      return;
    }
    createPunch.mutate(
      {
        weekStart,
        data: {
          kfiId,
          date: manualDate,
          source: manualSource,
          customer: manualSource === "Customer" ? manualCustomer : null,
          clockIn: manualClockIn,
          clockOut: manualClockOut,
        },
      },
      {
        onSuccess: (created) => {
          queryClient.invalidateQueries({ queryKey: getGetDriverWeekQueryKey(weekStart, kfiId) });
          setIsManualModalOpen(false);
          setManualClockIn("");
          setManualClockOut("");
          // ~10s undo: hits DELETE /punches/:id with the row we just
          // created. We don't dismiss the toast on click — the auto-timeout
          // closes it like any other.
          const t = toast({
            title: "Manual punch added",
            description: `${created.date} · ${created.clockIn} – ${created.clockOut}`,
            action: (
              <ToastAction
                altText="Undo"
                onClick={() => {
                  deletePunch.mutate(
                    { id: created.id },
                    {
                      onSuccess: () => {
                        queryClient.invalidateQueries({
                          queryKey: getGetDriverWeekQueryKey(weekStart, kfiId),
                        });
                        toast({ title: "Punch reverted" });
                      },
                      onError: (err) =>
                        handleLockedError(err, "Undo failed"),
                    },
                  );
                  t.dismiss();
                }}
              >
                <Undo2 className="h-3 w-3 mr-1" />
                Undo
              </ToastAction>
            ),
          });
          setTimeout(() => t.dismiss(), 10_000);
        },
        onError: (err) => handleLockedError(err, "Failed to add punch"),
      },
    );
  };

  // Strip the stored "YYYY-MM-DD " prefix so the dispatcher only has to type
  // the time. The server's PATCH /punches/:id route auto-anchors a bare time
  // back against the existing punch's date, so a one-click save with just
  // "7:32 AM" round-trips as a fully-prefixed wall-clock string.
  const stripDatePrefix = (s: string): string =>
    s.replace(/^\d{4}-\d{2}-\d{2}\s+/, "").trim();

  const startEdit = (p: Punch) => {
    setEditingPunchId(p.id);
    setEditClockIn(stripDatePrefix(p.clockIn));
    setEditClockOut(stripDatePrefix(p.clockOut));
    // Tell other dispatchers we've claimed this row so they don't stomp on
    // the same punch mid-edit; the server fans the event out via SSE and
    // expires the claim after 12s if we never release.
    claim(p.id);
  };

  const cancelEdit = () => {
    if (editingPunchId !== null) release(editingPunchId);
    setEditingPunchId(null);
  };

  const saveEdit = (id: number) => {
    editPunch.mutate(
      { id, data: { clockIn: editClockIn, clockOut: editClockOut } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetDriverWeekQueryKey(weekStart, kfiId) });
          release(id);
          setEditingPunchId(null);
          toast({ title: "Punch updated" });
        },
        onError: (err) => handleLockedError(err, "Failed to update punch"),
      },
    );
  };

  const startEditDay = (date: string, currentTotal: number, rowId: number) => {
    cancelEdit();
    setEditingDay(date);
    setEditingDayValue(currentTotal.toFixed(2));
    setEditingDayRowId(rowId);
  };

  const cancelEditDay = () => {
    setEditingDay(null);
    setEditingDayValue("");
    setEditingDayRowId(null);
  };

  const saveEditDay = (date: string) => {
    const target = parseFloat(editingDayValue);
    if (!Number.isFinite(target) || target < 0 || target > 24) {
      toast({
        title: "Invalid total",
        description: "Enter a number between 0 and 24.",
        variant: "destructive",
      });
      return;
    }
    scaleDayHours.mutate(
      { weekStart, kfiId, date, data: { totalHours: target } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getGetDriverWeekQueryKey(weekStart, kfiId),
          });
          queryClient.invalidateQueries({
            queryKey: getGetWeekSummaryQueryKey(weekStart),
          });
          setEditingDay(null);
          setEditingDayValue("");
          setEditingDayRowId(null);
          toast({ title: `Daily total set to ${target.toFixed(2)}h` });
        },
        onError: (err) => handleLockedError(err, "Couldn't update daily total"),
      },
    );
  };

  const handleResetDay = (date: string) => {
    if (
      !confirm(
        `Reset ${date} back to the engine-derived total? Each punch's hours will be recomputed from its clock-in / clock-out.`,
      )
    ) {
      return;
    }
    resetDayHours.mutate(
      { weekStart, kfiId, date },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getGetDriverWeekQueryKey(weekStart, kfiId),
          });
          queryClient.invalidateQueries({
            queryKey: getGetWeekSummaryQueryKey(weekStart),
          });
          toast({ title: `Daily total reset for ${date}` });
        },
        onError: (err) => handleLockedError(err, "Couldn't reset daily total"),
      },
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
        onError: (err) => handleLockedError(err, "Failed to delete punch"),
      },
    );
  };

  if (isLoading || isError || !data) {
    return (
      <div className="min-h-[100dvh] flex flex-col bg-background">
        <header className="sticky top-0 z-10 bg-sidebar text-sidebar-foreground border-b border-sidebar-border px-4 h-14 flex items-center gap-4 shadow-sm">
          <DriversSidebarMobileTrigger
            weekStart={weekStart}
            selectedKfiId={kfiId}
            className="text-sidebar-foreground hover:bg-sidebar-accent"
          />
          <Link href="/" title="KFI Staffing" className="no-underline"><Logo /></Link>
          <div className="h-5 w-px bg-sidebar-border/60" />
          <Link href={`/weeks/${weekStart}`}>
            <Button variant="ghost" size="icon" className="h-8 w-8 text-sidebar-foreground hover:bg-sidebar-accent">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <h1 className="font-display font-bold text-lg tracking-tight">
            Week of <span className="font-mono">{weekStart}</span>
          </h1>
        </header>
        <div className="flex-1 flex min-h-0">
          <DriversSidebar
            weekStart={weekStart}
            selectedKfiId={kfiId}
            collapsed={sidebarCollapsed}
            onToggle={toggleSidebar}
          />
          <main className="flex-1 flex items-center justify-center p-8">
            {isLoading ? (
              <Loader2 className="h-8 w-8 animate-spin" />
            ) : (
              <p className="text-destructive">{t("driverDetail.loadFailed")}</p>
            )}
          </main>
        </div>
      </div>
    );
  }

  // Chronological sort using the same parser the server hours engine uses, so
  // the running-total split aligns with regularHours / overtimeHours.
  const sortedPunches = [...data.punches].sort((a, b) => {
    const ta = localStrToSortMs(a.clockIn) ?? isoDateToUtcMs(a.date);
    const tb = localStrToSortMs(b.clockIn) ?? isoDateToUtcMs(b.date);
    return ta - tb;
  });

  // Client-side running totals + OT flag, mirroring hoursEngine.computeDriverTotals.
  // The OT flag drives the running-cell color rule (warning past 40h).
  let running = 0;
  const rows = sortedPunches.map((p) => {
    const before = running;
    const h = Number(p.hours) || 0;
    running = before + h;
    const otBefore = Math.max(0, before - OT_THRESHOLD);
    const otAfter = Math.max(0, running - OT_THRESHOLD);
    const otPortion = otAfter - otBefore;
    const isOt = otPortion > 0.0001 || running >= OT_THRESHOLD - 0.0001;
    return { p, after: running, isOt };
  });

  // Week-level reviewed counter surfaced in the header pill.
  const weekReviewedCount = sortedPunches.filter((p) => p.reviewed).length;
  const weekPunchCount = sortedPunches.length;
  const weekFlaggedCount = sortedPunches.filter(
    (p) => (p as { flagged?: boolean }).flagged,
  ).length;

  const togglePunchReviewed = (punchId: number, next: boolean) => {
    setPunchReviewed.mutate(
      { id: punchId, data: { reviewed: next } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getGetDriverWeekQueryKey(weekStart, kfiId),
          });
          queryClient.invalidateQueries({
            queryKey: getGetWeekSummaryQueryKey(weekStart),
          });
        },
        onError: (err) => handleLockedError(err, "Failed to mark reviewed"),
      },
    );
  };

  const togglePunchFlagged = (punchId: number, next: boolean) => {
    setPunchFlagged.mutate(
      { id: punchId, data: { flagged: next } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getGetDriverWeekQueryKey(weekStart, kfiId),
          });
          queryClient.invalidateQueries({
            queryKey: getGetWeekSummaryQueryKey(weekStart),
          });
        },
        onError: (err) => handleLockedError(err, "Failed to flag punch"),
      },
    );
  };

  // Per-day totals keyed by YYYY-MM-DD. Used by the inline day-total row
  // inserted after the last punch of each date.
  const dailyTotalByDate = new Map<string, number>();
  const dayOverridesByDate = new Map<string, boolean>();
  for (const d of data.dailyTotals ?? []) {
    dailyTotalByDate.set(d.date, Number(d.totalHours) || 0);
    dayOverridesByDate.set(d.date, !!d.hasOverrides);
  }

  // For each overridden day, find the most-recently-updated punch on that
  // date so the badge tooltip can show "overridden by X on Y". Reuses the
  // per-punch attribution data already on the DriverWeek payload.
  const dayLastTouchByDate = new Map<
    string,
    { email: string | null; at: string | null }
  >();
  for (const p of sortedPunches) {
    if (!dayOverridesByDate.get(p.date)) continue;
    const prev = dayLastTouchByDate.get(p.date);
    const at = p.updatedAt ?? null;
    if (
      !prev ||
      (at && (!prev.at || new Date(at).getTime() > new Date(prev.at).getTime()))
    ) {
      dayLastTouchByDate.set(p.date, {
        email: p.updatedByEmail ?? p.createdByEmail ?? null,
        at,
      });
    }
  }

  const customerLabel = isCustomerNameUseful(data.driver.customer)
    ? data.driver.customer
    : t("driverDetail.needsRosterCleanup");

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background">
      <header className="sticky top-0 z-10 bg-sidebar text-sidebar-foreground border-b border-sidebar-border px-4 h-14 flex items-center justify-between shadow-sm print:hidden">
        <div className="flex items-center gap-3">
          <DriversSidebarMobileTrigger
            weekStart={weekStart}
            selectedKfiId={kfiId}
            className="text-sidebar-foreground hover:bg-sidebar-accent"
          />
          <Link href="/" title="KFI Staffing" className="no-underline"><Logo /></Link>
          <div className="h-5 w-px bg-sidebar-border/60" />
          <Link href={`/weeks/${weekStart}`}>
            <Button variant="ghost" size="sm" className="h-8 text-sidebar-foreground hover:bg-sidebar-accent gap-2">
              <ArrowLeft className="h-4 w-4" />
              {t("driverDetail.back")}
            </Button>
          </Link>
        </div>
        <div className="flex items-center gap-3">
          <PresenceChip viewers={viewers} selfEmail={me?.email ?? null} />
          <LanguageToggle />
          <ReviewedPill
            reviewed={flatDrivers.filter((d) => d.reviewed).length}
            total={flatDrivers.length}
            testId="pill-reviewed-progress"
          />
          {weekPunchCount > 0 && (
            <span
              className={cn(
                "inline-flex items-center gap-1 text-[11px] font-mono px-2 py-0.5 rounded border",
                weekReviewedCount === weekPunchCount
                  ? "border-emerald-400/40 text-emerald-300 bg-emerald-500/10"
                  : "border-sidebar-border/60 text-sidebar-foreground/80 bg-sidebar-accent/30",
              )}
              data-testid="pill-punch-reviewed-progress"
              title="Per-punch reviewed checkboxes"
            >
              {weekReviewedCount === weekPunchCount && (
                <CheckIcon className="h-3 w-3" />
              )}
              {weekReviewedCount}/{weekPunchCount} punches
            </span>
          )}
          {weekFlaggedCount > 0 && (
            <span
              className="inline-flex items-center gap-1 text-[11px] font-mono px-2 py-0.5 rounded border border-rose-500/40 text-rose-200 bg-rose-600/20"
              data-testid="pill-punch-flagged-count"
              title="Punches flagged for review on this driver-week"
            >
              <Flag className="h-3 w-3 fill-current" />
              {weekFlaggedCount} flagged
            </span>
          )}
          <div
            className="inline-flex items-center gap-2"
            data-testid="status-tristate"
          >
            <Checkbox
              id="reviewed"
              checked={driverStatus === "good"}
              onCheckedChange={(v) => setStatus(v ? "good" : null)}
              disabled={driverLocked || setReviewed.isPending}
              data-testid="checkbox-status-good"
              aria-label={t("driverDetail.markGoodAria")}
            />
            <span className="inline-flex items-center gap-1 text-xs font-medium text-sidebar-foreground">
              <CheckIcon className="h-3.5 w-3.5 text-emerald-500" />
              {t("driverDetail.good")}
            </span>
            <button
              type="button"
              onClick={() =>
                setStatus(driverStatus === "bad" ? null : "bad")
              }
              disabled={driverLocked || setReviewed.isPending}
              data-testid="button-status-bad"
              title={t("driverDetail.markBadTitleShort")}
              className={cn(
                "px-2.5 py-1 rounded-md text-xs font-medium inline-flex items-center gap-1.5 border transition-colors",
                driverStatus === "bad"
                  ? "bg-rose-600 text-white border-rose-700"
                  : "bg-sidebar-accent/40 hover:bg-sidebar-accent text-sidebar-foreground border-sidebar-border/60",
              )}
            >
              <ThumbsDown className="h-3.5 w-3.5" /> Bad
            </button>
          </div>
          {canLock && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleToggleLock}
              disabled={lockMutation.isPending || unlockMutation.isPending}
              data-testid="button-toggle-lock"
              title={driverLocked ? t("driverDetail.unlockTitle") : t("driverDetail.lockTitle")}
              className={cn(
                "text-sidebar-foreground hover:bg-sidebar-accent",
                driverLocked && "text-amber-300",
              )}
            >
              {driverLocked ? (
                <>
                  <Lock className="mr-2 h-4 w-4" /> {t("driverDetail.locked")}
                </>
              ) : (
                <>
                  <LockOpen className="mr-2 h-4 w-4" /> {t("driverDetail.lock")}
                </>
              )}
            </Button>
          )}
          {!canLock && driverLocked && (
            <span
              className="inline-flex items-center gap-1.5 text-xs font-mono text-amber-300"
              data-testid="badge-locked-readonly"
              title={
                data.lockedByEmail
                  ? t("weekSummary.status.lockedBy", { email: data.lockedByEmail })
                  : t("weekSummary.status.lockedShort")
              }
            >
              <Lock className="h-3.5 w-3.5" /> {t("driverDetail.locked")}
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRefresh}
            disabled={refreshCt.isPending}
            className="text-sidebar-foreground hover:bg-sidebar-accent"
          >
            {refreshCt.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            {t("common.refresh")}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setIsManualModalOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            {t("driverDetail.addPunch")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => window.print()}
            title={t("driverDetail.printTimesheet")}
            data-testid="button-print-timesheet"
            className="text-sidebar-foreground hover:bg-sidebar-accent"
          >
            <Printer className="mr-2 h-4 w-4" />
            {t("common.print")}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setShortcutsOpen(true)}
            title={t("driverDetail.shortcuts")}
            data-testid="button-show-shortcuts"
            className="h-8 w-8 text-sidebar-foreground hover:bg-sidebar-accent"
          >
            <Keyboard className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        <div className="print:hidden contents">
          <DriversSidebar
            weekStart={weekStart}
            selectedKfiId={kfiId}
            collapsed={sidebarCollapsed}
            onToggle={toggleSidebar}
          />
        </div>

        <main className="print-sheet flex-1 p-6 max-w-7xl mx-auto w-full space-y-6 overflow-x-hidden print:p-0 print:max-w-none print:mx-0 print:overflow-visible print:space-y-4">
          <AllReviewedSplash
            visible={allReviewedSplashVisible}
            onDismiss={dismissAllReviewedSplash}
          />
          <FullyReconciledSplash
            visible={fullyReconciledSplashVisible}
            onDismiss={dismissFullyReconciledSplash}
          />
        {/* Title block */}
        <div className="space-y-2">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="font-display font-bold text-3xl tracking-tight leading-none">
              {formatPersonName(data.driver.name)}
            </h1>
            <EditingIndicator
              emails={Array.from(
                new Set(
                  data.punches
                    .map((p) => editorsForPunch(p.id))
                    .flat()
                    .concat(editorsForPunch(null)),
                ),
              )}
            />
          </div>
          <p className="text-sm text-muted-foreground font-mono flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>
              {t("driverDetail.customer")}{" "}
              <span className="text-foreground">{customerLabel}</span>
            </span>
            <span className="text-muted-foreground/60">·</span>
            <span>
              {t("driverDetail.kfiId")}{" "}
              <span className="text-foreground">{data.driver.kfiId}</span>
            </span>
            <span className="text-muted-foreground/60 print:hidden">·</span>
            <span className="print:hidden">
              <Popover open={tzPopoverOpen} onOpenChange={(o) => {
                setTzPopoverOpen(o);
                if (o) {
                  setTzDraft(data.driver.displayTz ?? "__default__");
                  setShiftHours("1");
                }
              }}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    data-testid="button-driver-tz"
                    title="Display timezone — click to change override, re-pull, or shift existing punches."
                    className="inline-flex items-center gap-1 rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[11px] hover:bg-muted"
                  >
                    <Globe className="h-3 w-3" />
                    <span className="font-mono">
                      {data.driver.effectiveDispTz ?? "America/Chicago"}
                    </span>
                    {data.driver.displayTz ? (
                      <Badge
                        variant="outline"
                        className="ml-1 h-4 px-1 text-[9px] font-mono border-primary/40 text-primary"
                      >
                        override
                      </Badge>
                    ) : null}
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-80 space-y-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Display timezone</Label>
                    <Select value={tzDraft} onValueChange={setTzDraft}>
                      <SelectTrigger className="h-8 text-xs" data-testid="select-driver-tz">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__default__" className="text-xs">
                          (default — customer / system)
                        </SelectItem>
                        {(allowedTzs?.allowed ?? []).map((tz) => (
                          <SelectItem key={tz} value={tz} className="text-xs">
                            {tz}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-[10px] text-muted-foreground">
                      Saving only changes future ingests. Use "Re-pull
                      Connecteam" to restamp this week from Connecteam, or
                      "Shift existing" to add Xh to every punch already
                      stored.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={updateDriverTz.isPending}
                      data-testid="button-save-driver-tz"
                      onClick={() =>
                        updateDriverTz.mutate(
                          {
                            kfiId,
                            data: {
                              displayTz:
                                tzDraft === "__default__" ? null : tzDraft,
                            },
                          },
                          {
                            onSuccess: () => {
                              queryClient.invalidateQueries({
                                queryKey: getGetDriverWeekQueryKey(
                                  weekStart,
                                  kfiId,
                                ),
                              });
                              queryClient.invalidateQueries({
                                queryKey: getGetWeekSummaryQueryKey(weekStart),
                              });
                              toast({
                                title: "Timezone updated",
                                description:
                                  tzDraft === "__default__"
                                    ? "Cleared override."
                                    : `Now ${tzDraft}.`,
                              });
                            },
                            onError: (err) =>
                              toast({
                                title: "Update failed",
                                description:
                                  err instanceof Error
                                    ? err.message
                                    : "Unknown error",
                                variant: "destructive",
                              }),
                          },
                        )
                      }
                    >
                      {updateDriverTz.isPending ? (
                        <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                      ) : (
                        <Save className="h-3 w-3 mr-1" />
                      )}
                      Save
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={refreshCtForDriver.isPending}
                      data-testid="button-repull-driver-ct"
                      onClick={() =>
                        refreshCtForDriver.mutate(
                          { weekStart, kfiId },
                          {
                            onSuccess: (res) => {
                              queryClient.invalidateQueries({
                                queryKey: getGetDriverWeekQueryKey(
                                  weekStart,
                                  kfiId,
                                ),
                              });
                              queryClient.invalidateQueries({
                                queryKey: getGetWeekSummaryQueryKey(weekStart),
                              });
                              toast({
                                title: "Re-pulled from Connecteam",
                                description: `${res.punchesUpserted} punches restamped.`,
                              });
                              setTzPopoverOpen(false);
                            },
                            onError: (err) =>
                              toast({
                                title: "Re-pull failed",
                                description:
                                  err instanceof Error
                                    ? err.message
                                    : "Unknown error",
                                variant: "destructive",
                              }),
                          },
                        )
                      }
                    >
                      {refreshCtForDriver.isPending ? (
                        <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3 w-3 mr-1" />
                      )}
                      Re-pull Connecteam
                    </Button>
                  </div>
                  <div className="space-y-1 border-t border-border/40 pt-2">
                    <Label className="text-xs">
                      Shift existing punches by (hours)
                    </Label>
                    <div className="flex items-center gap-2">
                      <Input
                        value={shiftHours}
                        onChange={(e) => setShiftHours(e.target.value)}
                        className="h-7 w-20 text-xs font-mono"
                        data-testid="input-shift-hours"
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={shiftPunches.isPending}
                        data-testid="button-shift-punches"
                        onClick={() => {
                          const n = Number(shiftHours);
                          if (!Number.isFinite(n) || n === 0) {
                            toast({
                              title: "Invalid shift",
                              description:
                                "Enter a non-zero number of hours (e.g. 1 or -1).",
                              variant: "destructive",
                            });
                            return;
                          }
                          shiftPunches.mutate(
                            {
                              weekStart,
                              kfiId,
                              data: {
                                offsetHours: n,
                                newDispTz:
                                  tzDraft === "__default__" ? null : tzDraft,
                              },
                            },
                            {
                              onSuccess: (res) => {
                                queryClient.invalidateQueries({
                                  queryKey: getGetDriverWeekQueryKey(
                                    weekStart,
                                    kfiId,
                                  ),
                                });
                                queryClient.invalidateQueries({
                                  queryKey: getGetWeekSummaryQueryKey(
                                    weekStart,
                                  ),
                                });
                                toast({
                                  title: "Punches shifted",
                                  description: `${res.shifted} punches moved by ${n}h.`,
                                });
                                setTzPopoverOpen(false);
                              },
                              onError: (err) =>
                                toast({
                                  title: "Shift failed",
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
                        {shiftPunches.isPending ? (
                          <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                        ) : null}
                        Shift
                      </Button>
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            </span>
            {/*
              Per-customer tz badges. Surface every distinct (customer,
              disp_tz) the engine sees on this driver-week so a dispatcher
              can spot — at a glance — when one customer feed landed in a
              tz that doesn't agree with the driver's effective tz. Amber
              styling + popover lets them save the customer's preferred
              default and/or shift this week's customer-source rows
              in-place without leaving the page.
            */}
            {(data.customerTzs ?? []).map((ct) => {
              const popKey = `${ct.customer}|${ct.dispTz}`;
              const isMismatch = !ct.matchesDriver;
              return (
                <span key={popKey} className="print:hidden">
                  <Popover
                    open={openCustomerTz === popKey}
                    onOpenChange={(o) => {
                      setOpenCustomerTz(o ? popKey : null);
                      if (o) {
                        setCustomerTzDraft(
                          ct.preferredDispTz ?? ct.dispTz ?? "__driver__",
                        );
                        // Pre-fill shift with the whole-hour delta between
                        // the customer's current tz and the driver's
                        // effective tz when we can compute it cheaply,
                        // otherwise leave the dispatcher to enter it.
                        setCustomerShiftHours("1");
                      }
                    }}
                  >
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        data-testid={`button-customer-tz-${ct.customer}`}
                        title={
                          isMismatch
                            ? `${ct.customer} feed is landing in ${ct.dispTz} (driver default ${data.driver.effectiveDispTz}). Click to save a customer default or shift existing punches.`
                            : `${ct.customer} feed matches driver tz (${ct.dispTz}).`
                        }
                        className={cn(
                          "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px]",
                          isMismatch
                            ? "border-amber-400/50 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20"
                            : "border-border/60 bg-muted/40 hover:bg-muted",
                        )}
                      >
                        <Globe className="h-3 w-3" />
                        <span className="font-mono">{ct.customer}:</span>
                        <span className="font-mono">{ct.dispTz}</span>
                        {ct.preferredDispTz ? (
                          <Badge
                            variant="outline"
                            className="ml-1 h-4 px-1 text-[9px] font-mono border-primary/40 text-primary"
                          >
                            pref
                          </Badge>
                        ) : null}
                      </button>
                    </PopoverTrigger>
                    <PopoverContent align="start" className="w-80 space-y-3">
                      <div className="space-y-1">
                        <Label className="text-xs">
                          {ct.customer} — preferred timezone
                        </Label>
                        <Select
                          value={customerTzDraft}
                          onValueChange={setCustomerTzDraft}
                        >
                          <SelectTrigger
                            className="h-8 text-xs"
                            data-testid={`select-customer-tz-${ct.customer}`}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__driver__" className="text-xs">
                              (use driver default —{" "}
                              {data.driver.effectiveDispTz})
                            </SelectItem>
                            {(allowedTzs?.allowed ?? []).map((tz) => (
                              <SelectItem
                                key={tz}
                                value={tz}
                                className="text-xs"
                              >
                                {tz}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <p className="text-[10px] text-muted-foreground">
                          Saving updates only future uploads for this
                          customer. Use "Shift existing" below to fix the
                          punches already on this week.
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={
                            upsertCustomerTz.isPending ||
                            customerTzDraft === "__driver__"
                          }
                          data-testid={`button-save-customer-tz-${ct.customer}`}
                          onClick={() =>
                            upsertCustomerTz.mutate(
                              {
                                data: {
                                  customer: ct.customer,
                                  displayTz: customerTzDraft,
                                },
                              },
                              {
                                onSuccess: () => {
                                  queryClient.invalidateQueries({
                                    queryKey: getGetDriverWeekQueryKey(
                                      weekStart,
                                      kfiId,
                                    ),
                                  });
                                  toast({
                                    title: "Customer timezone saved",
                                    description: `${ct.customer} → ${customerTzDraft} for future uploads.`,
                                  });
                                },
                                onError: (err) =>
                                  toast({
                                    title: "Save failed",
                                    description:
                                      err instanceof Error
                                        ? err.message
                                        : "Unknown error",
                                    variant: "destructive",
                                  }),
                              },
                            )
                          }
                        >
                          {upsertCustomerTz.isPending ? (
                            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                          ) : (
                            <Save className="h-3 w-3 mr-1" />
                          )}
                          Save as default
                        </Button>
                      </div>
                      <div className="space-y-1 border-t border-border/40 pt-2">
                        <Label className="text-xs">
                          Shift {ct.customer}&apos;s existing punches by
                          (hours)
                        </Label>
                        <div className="flex items-center gap-2">
                          <Input
                            value={customerShiftHours}
                            onChange={(e) =>
                              setCustomerShiftHours(e.target.value)
                            }
                            className="h-7 w-20 text-xs font-mono"
                            data-testid={`input-customer-shift-${ct.customer}`}
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={shiftPunches.isPending}
                            data-testid={`button-customer-shift-${ct.customer}`}
                            onClick={() => {
                              const n = Number(customerShiftHours);
                              if (!Number.isFinite(n) || n === 0) {
                                toast({
                                  title: "Invalid shift",
                                  description:
                                    "Enter a non-zero number of hours (e.g. 1 or -1).",
                                  variant: "destructive",
                                });
                                return;
                              }
                              shiftPunches.mutate(
                                {
                                  weekStart,
                                  kfiId,
                                  data: {
                                    offsetHours: n,
                                    source: "Customer",
                                    customer: ct.customer,
                                    newDispTz:
                                      customerTzDraft === "__driver__"
                                        ? null
                                        : customerTzDraft,
                                  },
                                },
                                {
                                  onSuccess: (res) => {
                                    queryClient.invalidateQueries({
                                      queryKey: getGetDriverWeekQueryKey(
                                        weekStart,
                                        kfiId,
                                      ),
                                    });
                                    queryClient.invalidateQueries({
                                      queryKey:
                                        getGetWeekSummaryQueryKey(weekStart),
                                    });
                                    toast({
                                      title: "Customer punches shifted",
                                      description: `${res.shifted} ${ct.customer} rows moved by ${n}h.`,
                                    });
                                    setOpenCustomerTz(null);
                                  },
                                  onError: (err) =>
                                    toast({
                                      title: "Shift failed",
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
                            {shiftPunches.isPending ? (
                              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                            ) : null}
                            Shift
                          </Button>
                        </div>
                      </div>
                    </PopoverContent>
                  </Popover>
                </span>
              );
            })}
            <span className="hidden print:inline">
              <span className="mx-2 text-muted-foreground/60">·</span>
              {t("common.weekOf", { week: weekStart })}
            </span>
          </p>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted-foreground pt-1 print:hidden">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-sidebar" />
              {t("driverDetail.driverConnect")}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-primary" />
              {t("driverDetail.customerSource")}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-warning" />
              {t("driverDetail.overtimeThreshold")}
            </span>
          </div>
        </div>


        {driverLocked && (
          <Card
            className="border-amber-500/40 bg-amber-50/40 dark:bg-amber-950/20"
            data-testid="card-locked-banner"
          >
            <CardContent className="flex items-center gap-3 px-4 py-3 text-sm">
              <Lock className="h-4 w-4 text-amber-700 dark:text-amber-400" />
              <span className="text-amber-900 dark:text-amber-200">
                {t("driverDetail.lockedBanner", {
                  by: data.lockedByEmail ? t("driverDetail.lockedBannerBy", { email: data.lockedByEmail }) : "",
                  at: data.lockedAt ? t("driverDetail.lockedBannerAt", { time: new Date(data.lockedAt).toLocaleString() }) : "",
                })}
              </span>
            </CardContent>
          </Card>
        )}

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

        {/* Summary + Checks panels — surface the per-source RT/OT split and an
            independent re-derivation, so any divergence is obvious. */}
        <SummaryAndChecks
          totals={data.totals}
          connecteamParity={data.connecteamParity ?? null}
        />

        {/* Zenople pay & bill rates (admin-edit) */}
        <PayrollProfileCard kfiId={kfiId} canEdit={!!me?.isAdmin} />

        {/* Punch table */}

        <Card>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[110px] uppercase text-[11px] tracking-wider">Date</TableHead>
                  <TableHead className="w-[110px] uppercase text-[11px] tracking-wider">Source</TableHead>
                  <TableHead className="uppercase text-[11px] tracking-wider">Clock In</TableHead>
                  <TableHead className="uppercase text-[11px] tracking-wider">Clock Out</TableHead>
                  <TableHead className="text-right uppercase text-[11px] tracking-wider w-[80px]">Hours</TableHead>
                  <TableHead className="text-right uppercase text-[11px] tracking-wider w-[90px]">Running</TableHead>
                  <TableHead className="text-right uppercase text-[11px] tracking-wider w-[100px]">Type</TableHead>
                  <TableHead className="text-right w-[90px] print:hidden"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-10 text-muted-foreground">
                      No punches recorded for this week.
                    </TableCell>
                  </TableRow>
                )}
                {rows.map(({ p, after, isOt }) => {
                  const isEditing = editingPunchId === p.id;
                  const isDriver = p.source === "Driver";
                  const remaining = OT_THRESHOLD - after;
                  // Source-driven faint bg wash on time cells: navy for Driver,
                  // teal for Customer. Subtle, but unmistakable at a glance and
                  // still readable on top of the OT highlight (bg-warning/10).
                  const sourceCellTint = isDriver
                    ? "bg-sidebar/[0.06] dark:bg-sidebar-accent/30"
                    : "bg-primary/[0.07] dark:bg-primary/15";
                  const tooltipLine =
                    remaining > 0.0001
                      ? `${remaining.toFixed(2)}h until OT`
                      : remaining < -0.0001
                        ? `${Math.abs(remaining).toFixed(2)}h over OT`
                        : `at the 40h OT line`;
                  const punchNotes = notesByPunch.get(p.id) ?? [];
                  const noteOpen = openNoteForPunch === p.id;
                  const rowEditors = editorsForPunch(p.id);
                  return (
                    <Fragment key={p.id}>
                    <TableRow
                      id={`punch-row-${p.id}`}
                      data-testid={`row-punch-${p.id}`}
                      data-flagged={
                        (p as { flagged?: boolean }).flagged ? "true" : undefined
                      }
                      className={cn(
                        isOt && "bg-warning/10 hover:bg-warning/15",
                        (p as { flagged?: boolean }).flagged &&
                          "bg-rose-500/10 hover:bg-rose-500/15 border-l-2 border-l-rose-500",
                        "scroll-mt-24 transition-colors [&>td]:py-1.5",
                      )}
                    >
                      <TableCell className="font-mono text-xs whitespace-nowrap align-top">
                        <div>{p.date}</div>
                      </TableCell>
                      <TableCell>
                        <SourceBadge source={p.source} />
                        <div className="flex flex-wrap items-center gap-1 mt-1">
                          {p.isManual && (
                            <span className="text-[9px] uppercase tracking-wider px-1 py-0 rounded border border-border text-muted-foreground">
                              Manual
                            </span>
                          )}
                          {p.edited && (
                            <span className="text-[9px] uppercase tracking-wider px-1 py-0 rounded border border-border text-muted-foreground">
                              Edited
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className={cn("font-mono text-xs whitespace-nowrap", sourceCellTint)}>
                        {isEditing ? (
                          <Input
                            autoFocus
                            className="h-7 w-24 font-mono text-xs"
                            placeholder="7:30 AM"
                            value={editClockIn}
                            onChange={(e) => {
                              setEditClockIn(e.target.value);
                              touchActivity(p.id);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                saveEdit(p.id);
                              } else if (e.key === "Escape") {
                                e.preventDefault();
                                cancelEdit();
                              }
                            }}
                            data-testid={`input-edit-clock-in-${p.id}`}
                          />
                        ) : (
                          formatClockCell(p.clockIn)
                        )}
                      </TableCell>
                      <TableCell className={cn("font-mono text-xs whitespace-nowrap", sourceCellTint)}>
                        {isEditing ? (
                          <Input
                            className="h-7 w-24 font-mono text-xs"
                            placeholder="3:45 PM"
                            value={editClockOut}
                            onChange={(e) => {
                              setEditClockOut(e.target.value);
                              touchActivity(p.id);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                saveEdit(p.id);
                              } else if (e.key === "Escape") {
                                e.preventDefault();
                                cancelEdit();
                              }
                            }}
                            data-testid={`input-edit-clock-out-${p.id}`}
                          />
                        ) : (
                          formatClockCell(p.clockOut)
                        )}
                      </TableCell>
                      <TableCell className={cn("text-right font-mono font-medium text-xs", sourceCellTint)}>
                        {isEditing ? (
                          <>
                            {editPreview ? editPreview.hours.toFixed(2) : p.hours.toFixed(2)}
                            {editPreview && (
                              <div
                                className="text-[10px] font-normal text-muted-foreground mt-0.5 leading-tight"
                                data-testid={`edit-preview-${p.id}`}
                              >
                                <div>day {editPreview.dailyTotalAfter.totalHours.toFixed(2)}h</div>
                                <div>
                                  wk RT {editPreview.weekly.regularHours.toFixed(2)}h ·
                                  {" "}
                                  <span className={editPreview.weekly.overtimeHours > 0.005 ? "text-warning font-semibold" : ""}>
                                    OT {editPreview.weekly.overtimeHours.toFixed(2)}h
                                  </span>
                                </div>
                              </div>
                            )}
                          </>
                        ) : (() => {
                          const isOverridden = dayOverridesByDate.get(p.date) ?? false;
                          const lastTouch = dayLastTouchByDate.get(p.date);
                          const overrideTitle = isOverridden
                            ? `Day total overridden${lastTouch?.email ? ` by ${lastTouch.email}` : ""}${lastTouch?.at ? ` on ${new Date(lastTouch.at).toLocaleString()}` : ""} — click to re-edit`
                            : "Click to set this day's total — punches will be scaled proportionally";
                          const isEditorOnThisRow =
                            editingDay === p.date && editingDayRowId === p.id;
                          const isSavingThisDay =
                            (scaleDayHours.isPending || resetDayHours.isPending) &&
                            editingDay === p.date;
                          if (isEditorOnThisRow) {
                            const dayTotal = dailyTotalByDate.get(p.date) ?? 0;
                            return (
                              <span
                                className="inline-flex items-center gap-0.5 justify-end"
                                data-testid={`row-day-total-${p.date}`}
                              >
                                <Input
                                  autoFocus
                                  type="number"
                                  step="0.01"
                                  min="0"
                                  max="24"
                                  className="h-6 w-16 font-mono text-xs px-1 py-0"
                                  value={editingDayValue}
                                  onChange={(e) => setEditingDayValue(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                      e.preventDefault();
                                      saveEditDay(p.date);
                                    } else if (e.key === "Escape") {
                                      e.preventDefault();
                                      cancelEditDay();
                                    }
                                  }}
                                  data-testid={`input-day-total-${p.date}`}
                                  title={`Day total (currently ${dayTotal.toFixed(2)}h)`}
                                />
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-5 w-5 text-green-600"
                                  onClick={() => saveEditDay(p.date)}
                                  disabled={isSavingThisDay}
                                  data-testid={`button-save-day-total-${p.date}`}
                                >
                                  {isSavingThisDay ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                  ) : (
                                    <Save className="h-3 w-3" />
                                  )}
                                </Button>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-5 w-5 text-muted-foreground"
                                  onClick={cancelEditDay}
                                  data-testid={`button-cancel-day-total-${p.date}`}
                                >
                                  <X className="h-3 w-3" />
                                </Button>
                              </span>
                            );
                          }
                          return (
                            <span className="inline-flex items-center gap-0.5 justify-end">
                              <button
                                type="button"
                                onClick={() => {
                                  const dayTotal = dailyTotalByDate.get(p.date) ?? 0;
                                  startEditDay(p.date, dayTotal, p.id);
                                }}
                                className={cn(
                                  "font-mono tabular-nums px-1 py-0 rounded hover:underline decoration-dotted underline-offset-2 cursor-pointer",
                                  isOverridden
                                    ? "border border-amber-400/50 bg-amber-500/10 text-amber-700 dark:text-amber-300 font-medium"
                                    : "hover:text-foreground",
                                )}
                                title={overrideTitle}
                                data-testid={`button-edit-day-total-${p.date}`}
                              >
                                {p.hours.toFixed(2)}
                              </button>
                              {isOverridden && (
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-5 w-5 text-amber-700 dark:text-amber-300 hover:text-foreground print:hidden"
                                  onClick={() => handleResetDay(p.date)}
                                  disabled={resetDayHours.isPending}
                                  title="Reset this day back to the engine-derived total"
                                  data-testid={`button-reset-day-total-${p.date}`}
                                >
                                  <Undo2 className="h-3 w-3" />
                                </Button>
                              )}
                            </span>
                          );
                        })()}
                      </TableCell>
                      <TableCell className="text-right">
                        <TooltipProvider delayDuration={150}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span
                                className={cn(
                                  "font-mono text-xs tabular-nums cursor-help",
                                  isOt ? "text-warning font-semibold" : "text-muted-foreground",
                                )}
                              >
                                {after.toFixed(2)}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="font-mono text-[11px] leading-relaxed">
                              <div>Cumulative: {after.toFixed(2)}h</div>
                              <div>{tooltipLine}</div>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </TableCell>
                      <TableCell
                        className={cn(
                          "text-right font-medium text-xs",
                          isDriver ? "text-sidebar dark:text-sidebar-foreground" : "text-primary",
                        )}
                      >
                        {p.source}
                      </TableCell>
                      <TableCell className="text-right print:hidden">
                        {isEditing ? (
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7 text-green-600"
                              onClick={() => saveEdit(p.id)}
                              data-testid={`button-save-punch-${p.id}`}
                            >
                              <Save className="h-3 w-3" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7 text-muted-foreground"
                              onClick={cancelEdit}
                              data-testid={`button-cancel-edit-punch-${p.id}`}
                            >
                              <X className="h-3 w-3" />
                            </Button>
                          </div>
                        ) : (
                          <div className="flex items-center justify-end gap-1 opacity-60 hover:opacity-100">
                            <TooltipProvider delayDuration={150}>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="inline-flex items-center">
                                    <Checkbox
                                      checked={!!p.reviewed}
                                      disabled={driverLocked || setPunchReviewed.isPending}
                                      onCheckedChange={(v) =>
                                        togglePunchReviewed(p.id, !!v)
                                      }
                                      aria-label="Mark this punch reviewed"
                                      data-testid={`checkbox-punch-reviewed-${p.id}`}
                                      className="h-4 w-4"
                                    />
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent side="top" className="text-[11px]">
                                  {p.reviewed
                                    ? p.reviewedByEmail
                                      ? `Reviewed by ${p.reviewedByEmail}${
                                          p.reviewedAt
                                            ? ` · ${new Date(p.reviewedAt).toLocaleString()}`
                                            : ""
                                        }`
                                      : "Reviewed"
                                    : "Mark this punch reviewed"}
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                            <TooltipProvider delayDuration={150}>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    className={cn(
                                      "h-7 w-7",
                                      (p as { flagged?: boolean }).flagged
                                        ? "text-rose-600 hover:text-rose-700 dark:text-rose-400"
                                        : "text-muted-foreground hover:text-rose-600",
                                    )}
                                    disabled={driverLocked || setPunchFlagged.isPending}
                                    onClick={() =>
                                      togglePunchFlagged(
                                        p.id,
                                        !(p as { flagged?: boolean }).flagged,
                                      )
                                    }
                                    aria-label={
                                      (p as { flagged?: boolean }).flagged
                                        ? "Clear review flag"
                                        : "Flag this punch for review"
                                    }
                                    aria-pressed={
                                      !!(p as { flagged?: boolean }).flagged
                                    }
                                    data-testid={`button-punch-flag-${p.id}`}
                                  >
                                    <Flag
                                      className={cn(
                                        "h-3 w-3",
                                        (p as { flagged?: boolean }).flagged &&
                                          "fill-current",
                                      )}
                                    />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent side="top" className="text-[11px]">
                                  {(p as { flagged?: boolean }).flagged
                                    ? (p as { flaggedByEmail?: string | null })
                                        .flaggedByEmail
                                      ? `Flagged by ${
                                          (p as { flaggedByEmail?: string | null })
                                            .flaggedByEmail
                                        }${
                                          (p as { flaggedAt?: string | null })
                                            .flaggedAt
                                            ? ` · ${new Date(
                                                (p as { flaggedAt?: string | null })
                                                  .flaggedAt!,
                                              ).toLocaleString()}`
                                            : ""
                                        } — click to clear`
                                      : "Flagged for review — click to clear"
                                    : "Flag this punch for review"}
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                            <Button
                              size="icon"
                              variant="ghost"
                              className={cn(
                                "h-7 w-7 hover:text-foreground",
                                punchNotes.length > 0 || noteOpen
                                  ? "text-primary"
                                  : "text-muted-foreground",
                              )}
                              onClick={() => {
                                setPunchNoteDraft("");
                                setOpenNoteForPunch(noteOpen ? null : p.id);
                              }}
                              title={
                                punchNotes.length > 0
                                  ? `${punchNotes.length} note${punchNotes.length === 1 ? "" : "s"}`
                                  : "Add a note"
                              }
                              data-testid={`button-toggle-note-punch-${p.id}`}
                            >
                              <MessageSquarePlus className="h-3 w-3" />
                              {punchNotes.length > 0 && (
                                <span className="ml-0.5 text-[9px] font-mono">
                                  {punchNotes.length}
                                </span>
                              )}
                            </Button>
                            {rowEditors.length > 0 && (
                              <EditingIndicator emails={rowEditors} />
                            )}
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7 text-muted-foreground hover:text-foreground"
                              onClick={() => startEdit(p)}
                              data-testid={`button-edit-punch-${p.id}`}
                            >
                              <Edit2 className="h-3 w-3" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10"
                              onClick={() => handleDelete(p.id)}
                              data-testid={`button-delete-punch-${p.id}`}
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                    {noteOpen && (
                      <TableRow
                        className="bg-muted/30 hover:bg-muted/30"
                        data-testid={`row-punch-notes-${p.id}`}
                      >
                        <TableCell colSpan={8} className="px-4 py-3">
                          <div className="space-y-2">
                            {punchNotes.length > 0 && (
                              <ul className="space-y-2">
                                {punchNotes.map((n) => (
                                  <NoteItem
                                    key={n.id}
                                    note={n}
                                    canDelete={!!me?.isAdmin}
                                    isAdmin={!!me?.isAdmin}
                                    onDelete={() => handleSoftDeleteNote(n.id)}
                                  />
                                ))}
                              </ul>
                            )}
                            {noteOpen && (
                              <div className="flex items-start gap-2">
                                <Textarea
                                  autoFocus
                                  value={punchNoteDraft}
                                  onChange={(e) => setPunchNoteDraft(e.target.value)}
                                  placeholder="Add a note about this punch…"
                                  className="min-h-[44px] text-sm flex-1"
                                  maxLength={5000}
                                  data-testid={`input-punch-note-${p.id}`}
                                />
                                <div className="flex flex-col gap-1">
                                  <Button
                                    size="sm"
                                    onClick={() =>
                                      submitNote(punchNoteDraft, p.id, () => {
                                        setPunchNoteDraft("");
                                        setOpenNoteForPunch(null);
                                      })
                                    }
                                    disabled={
                                      !punchNoteDraft.trim() || createNote.isPending
                                    }
                                    data-testid={`button-submit-punch-note-${p.id}`}
                                  >
                                    {createNote.isPending ? (
                                      <Loader2 className="h-3 w-3 animate-spin" />
                                    ) : (
                                      <Save className="h-3 w-3" />
                                    )}
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => {
                                      setOpenNoteForPunch(null);
                                      setPunchNoteDraft("");
                                    }}
                                    data-testid={`button-cancel-punch-note-${p.id}`}
                                  >
                                    <X className="h-3 w-3" />
                                  </Button>
                                </div>
                              </div>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </Card>
        </main>
      </div>

      <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Keyboard shortcuts</DialogTitle>
          </DialogHeader>
          <div className="text-sm space-y-2 py-2">
            <ShortcutRow keys={["j", "↓"]} label="Next driver" />
            <ShortcutRow keys={["k", "↑"]} label="Previous driver" />
            <ShortcutRow keys={["n"]} label="Next unreviewed driver" />
            <ShortcutRow keys={["p"]} label="Previous unreviewed driver" />
            <ShortcutRow keys={["r"]} label="Toggle reviewed" />
            <ShortcutRow keys={["?"]} label="Show this help" />
            <div className="flex items-center justify-between gap-4 pt-3 mt-2 border-t border-border">
              <label
                htmlFor="auto-advance-pref"
                className="text-foreground cursor-pointer"
              >
                Jump to next unreviewed after marking reviewed
              </label>
              <Checkbox
                id="auto-advance-pref"
                checked={autoAdvance}
                onCheckedChange={(v) => setAutoAdvance(v === true)}
                data-testid="checkbox-auto-advance"
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <label
                htmlFor="celebration-sound-pref"
                className="text-foreground cursor-pointer"
              >
                Play a chime when the week is fully reviewed
              </label>
              <Checkbox
                id="celebration-sound-pref"
                checked={celebrationSound}
                onCheckedChange={(v) => setCelebrationSound(v === true)}
                data-testid="checkbox-celebration-sound"
              />
            </div>
            <p className="text-xs text-muted-foreground pt-2">
              Shortcuts are ignored while typing in a field or while a dialog is open.
            </p>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={isManualModalOpen} onOpenChange={setIsManualModalOpen}>
        <DialogContent data-testid="dialog-add-manual-punch">
          <DialogHeader>
            <DialogTitle>Add Manual Punch</DialogTitle>
            <DialogDescription>
              Adds a new punch alongside the driver's existing entries. It
              never overwrites or replaces a Connecteam or customer-file
              punch — both will count toward the day. Manual punches are
              also preserved across the next Connecteam refresh.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label>Date</Label>
              <Input type="date" value={manualDate} onChange={(e) => setManualDate(e.target.value)} />
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
                    {manualCustomerOptions.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label>Clock In</Label>
                <Input placeholder="7:30 AM" value={manualClockIn} onChange={(e) => { setManualClockIn(e.target.value); touchActivity(null); }} data-testid="input-manual-clock-in" />
              </div>
              <div className="grid gap-2">
                <Label>Clock Out</Label>
                <Input placeholder="3:45 PM" value={manualClockOut} onChange={(e) => { setManualClockOut(e.target.value); touchActivity(null); }} data-testid="input-manual-clock-out" />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">Format as "H:MM AM/PM" (e.g. "8:00 AM"). The date is stored in this driver's display timezone, so what you see here is what payroll sees.</p>

            <PreviewPanel
              preview={dialogPreview}
              onViewOverlap={(id) => {
                setIsManualModalOpen(false);
                // Wait for the dialog close animation so the row is in view
                // and focusable when we scroll to it.
                setTimeout(() => {
                  const el = document.getElementById(`punch-row-${id}`);
                  if (!el) return;
                  el.scrollIntoView({ behavior: "smooth", block: "center" });
                  el.classList.add("ring-2", "ring-warning");
                  setTimeout(() => {
                    el.classList.remove("ring-2", "ring-warning");
                  }, 2000);
                }, 200);
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsManualModalOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleCreateManual}
              disabled={
                createPunch.isPending ||
                dialogPreview === null ||
                !dialogPreview.valid
              }
              data-testid="button-save-manual-punch"
            >
              {createPunch.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Punch
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Two-panel breakdown shown above the punch table on the per-driver page.
 *
 * - Summary mirrors the server's chronological RT/OT split (which the hours
 *   engine has already computed) and adds the per-source rows dispatchers
 *   need at payroll time, since Driver and Customer hours pay at different
 *   rates: Total Driver, Total Customer, RT, OT, Driver RT, Driver OT.
 * - Checks re-derives the same numbers from `totalDriver` / `totalCustomer`
 *   alone (without consulting the engine output) and shows ✓/✗ next to each
 *   row. Naive arithmetic divergence vs the chronological split is a strong
 *   signal of either bad data or an engine regression.
 */
function SummaryAndChecks({
  totals,
  connecteamParity,
}: {
  totals: {
    driverHours: number;
    customerHours: number;
    totalHours: number;
    regularHours: number;
    overtimeHours: number;
    driverRt: number;
    driverOt: number;
  };
  connecteamParity: {
    status: "match" | "differ" | "unknown" | string;
    diffCount: number;
    lastRefreshedAt?: string | null;
    baselineAgeHours?: number | null;
    baselineStale?: boolean;
    baselineStaleThresholdHours?: number;
    days: Array<{
      date: string;
      dashboardHours: number;
      customerHours: number;
      connecteamHours: number | null;
      matches: boolean | null;
    }>;
  } | null;
}) {
  // Connecteam parity badge driven by a real numeric comparison: each
  // /refresh-connecteam call snapshots the per-day Connecteam-side total
  // for this driver-week into `connecteam_daily_snapshots`, and the API
  // compares the live engine totals against that snapshot (within 0.005h).
  // - `match`   → every snapshotted day reconciles
  // - `differ`  → at least one day diverges (edits, manual punches on a day
  //               Connecteam doesn't know about, or new Connecteam shifts
  //               since the last refresh)
  // - `unknown` → no snapshot yet (driver-week never refreshed)
  const parityStatus = connecteamParity?.status ?? "unknown";
  const diffCount = connecteamParity?.diffCount ?? 0;
  const lastRefreshedAt = connecteamParity?.lastRefreshedAt ?? null;
  const refreshedNote = lastRefreshedAt
    ? ` Baseline refreshed ${new Date(lastRefreshedAt).toLocaleString()}.`
    : "";
  // Baseline staleness: a green "matches" badge against a hours-old snapshot
  // is misleading because Connecteam may have new shifts on its side that
  // the dashboard has no way to know about. When stale, replace the match
  // badge with a soft "baseline is N hours old" warning, and append a note
  // to the differ badge tooltip so dispatchers know to re-pull.
  const baselineStale = connecteamParity?.baselineStale === true;
  const baselineAgeHours = connecteamParity?.baselineAgeHours ?? null;
  const formatAge = (h: number): string => {
    if (h < 1) {
      const m = Math.max(1, Math.round(h * 60));
      return `${m} min`;
    }
    if (h < 24) {
      const r = Math.round(h);
      return `${r} hour${r === 1 ? "" : "s"}`;
    }
    const d = Math.round(h / 24);
    return `${d} day${d === 1 ? "" : "s"}`;
  };
  const ageLabel =
    baselineAgeHours != null ? formatAge(baselineAgeHours) : null;
  const staleNote =
    baselineStale && ageLabel
      ? ` Baseline is ${ageLabel} old — refresh to recheck.`
      : "";
  const diffDayList = (connecteamParity?.days ?? [])
    .filter((d) => d.matches === false)
    .map((d) => {
      const ct =
        d.connecteamHours == null ? "—" : `${d.connecteamHours.toFixed(2)}h`;
      const cust = `${d.customerHours.toFixed(2)}h`;
      const sum =
        d.connecteamHours == null
          ? "—"
          : `${(d.connecteamHours + d.customerHours).toFixed(2)}h`;
      const dash = `${d.dashboardHours.toFixed(2)}h`;
      return `${d.date}: CT ${ct} + Customer ${cust} = ${sum} vs Dashboard ${dash}`;
    })
    .join("\n");
  const totDriver = Number(totals.driverHours) || 0;
  const totCust = Number(totals.customerHours) || 0;
  const total = Number(totals.totalHours) || 0;
  const rt = Number(totals.regularHours) || 0;
  const ot = Number(totals.overtimeHours) || 0;
  const driverRt = Number(totals.driverRt) || 0;
  const driverOt = Number(totals.driverOt) || 0;

  // Independently re-derived from totDriver/totCust only. These are deliberately
  // *not* taken from the engine output — they cross-check it. RT/OT checks
  // start from (totDriver + totCust) rather than the engine's totalHours so a
  // bug in totalHours would surface here too.
  const checkTotal = totDriver + totCust;
  const checkCustomer = total - totDriver;
  const checkDriver = total - totCust;
  const checkRt = Math.min(checkTotal, OT_THRESHOLD);
  const checkOt = Math.max(0, checkTotal - OT_THRESHOLD);
  const rtPlusOt = rt + ot;

  const eq = (a: number, b: number) => Math.abs(a - b) < 0.015;

  const checks = [
    { label: "Total = Driver + Customer", expected: total, actual: checkTotal },
    { label: "Customer = Total − Driver", expected: totCust, actual: checkCustomer },
    { label: "Driver = Total − Customer", expected: totDriver, actual: checkDriver },
    { label: "RT = min(Total, 40)", expected: rt, actual: checkRt },
    { label: "OT = max(0, Total − 40)", expected: ot, actual: checkOt },
    { label: "RT + OT = Total", expected: total, actual: rtPlusOt },
  ];
  const allOk = checks.every((c) => eq(c.expected, c.actual));

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <Card data-testid="card-summary">
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-sm font-display tracking-tight flex items-center justify-between gap-2">
            <span>Summary</span>
            {parityStatus === "match" && baselineStale && ageLabel ? (
              <span
                className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-sm bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/40"
                data-testid="badge-ct-parity-stale"
                title={`Dashboard matches the snapshot, but the snapshot is ${ageLabel} old — Connecteam may have logged new shifts since.${refreshedNote} Re-pull Connecteam to recheck.`}
              >
                <AlertTriangle className="h-3 w-3" />
                Baseline {ageLabel} old — refresh to recheck
              </span>
            ) : parityStatus === "match" ? (
              <span
                className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-sm bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30"
                data-testid="badge-ct-parity-match"
                title={`Every day's dashboard total reconciles to the Connecteam baseline within 0.005h.${refreshedNote}`}
              >
                <CheckIcon className="h-3 w-3" />
                Matches Connecteam
              </span>
            ) : parityStatus === "differ" ? (
              <span
                className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-sm bg-warning/15 text-warning border border-warning/40"
                data-testid="badge-ct-parity-diff"
                title={`${diffCount} day${diffCount === 1 ? "" : "s"} diverge from the Connecteam baseline.${refreshedNote}${staleNote}${diffDayList ? `\n\n${diffDayList}` : ""}`}
              >
                <AlertTriangle className="h-3 w-3" />
                Differs from Connecteam ({diffCount})
              </span>
            ) : (
              <span
                className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-sm bg-muted text-muted-foreground border border-border"
                data-testid="badge-ct-parity-unknown"
                title="No Connecteam baseline yet — refresh from Connecteam to enable parity comparison."
              >
                Connecteam: not yet refreshed
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          <dl className="divide-y divide-border">
            <SummaryRow label="Total Driver" value={totDriver} testId="row-summary-total-driver" />
            <SummaryRow label="Total Customer" value={totCust} testId="row-summary-total-customer" />
            <SummaryRow label="Total Hours" value={total} testId="row-summary-total-hours" />
            <SummaryRow label="RT" value={rt} testId="row-summary-rt" />
            <SummaryRow
              label="OT"
              value={ot}
              valueClass={ot > 0.005 ? "text-warning" : undefined}
              testId="row-summary-ot"
            />
            <SummaryRow label="Driver RT" value={driverRt} testId="row-summary-driver-rt" />
            <SummaryRow
              label="Driver OT"
              value={driverOt}
              valueClass={driverOt > 0.005 ? "text-warning" : undefined}
              testId="row-summary-driver-ot"
            />
          </dl>
        </CardContent>
      </Card>

      <Card
        data-testid="card-checks"
        className={cn(
          allOk
            ? "border-emerald-500/40 bg-emerald-50/40 dark:bg-emerald-950/20"
            : "border-warning bg-warning/5",
        )}
      >
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle
            className={cn(
              "text-sm font-display tracking-tight flex items-center gap-2",
              allOk
                ? "text-emerald-700 dark:text-emerald-400"
                : "text-warning",
            )}
          >
            {allOk ? (
              <CheckIcon className="h-4 w-4" />
            ) : (
              <AlertCircle className="h-4 w-4" />
            )}
            Checks {allOk ? "— all reconcile" : "— mismatch"}
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          <dl className="divide-y divide-border">
            {checks.map((c) => {
              const ok = eq(c.expected, c.actual);
              return (
                <div
                  key={c.label}
                  className="flex items-center justify-between py-1.5 gap-3"
                  data-testid={`row-check-${c.label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`}
                >
                  <dt className="flex items-center gap-2 text-sm">
                    {ok ? (
                      <CheckIcon className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                    ) : (
                      <X className="h-3.5 w-3.5 text-warning" />
                    )}
                    <span className={cn(!ok && "text-warning font-medium")}>
                      {c.label}
                    </span>
                  </dt>
                  <dd
                    className={cn(
                      "font-mono tabular-nums text-sm",
                      !ok && "text-warning font-semibold",
                    )}
                  >
                    {c.actual.toFixed(2)}
                  </dd>
                </div>
              );
            })}
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}

function SummaryRow({
  label,
  value,
  valueClass,
  testId,
}: {
  label: string;
  value: number;
  valueClass?: string;
  testId?: string;
}) {
  return (
    <div className="flex items-center justify-between py-1.5" data-testid={testId}>
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className={cn("font-mono tabular-nums text-sm font-semibold", valueClass)}>
        {value.toFixed(2)}
      </dd>
    </div>
  );
}

function NoteItem({
  note,
  canDelete,
  isAdmin,
  onDelete,
}: {
  note: {
    id: number;
    body: string;
    authorEmail?: string | null;
    authorRole: string;
    createdAt: string;
    punchExists: boolean;
    punchId?: number | null;
    lastHiddenAt?: string | null;
    lastHiddenByEmail?: string | null;
  };
  canDelete: boolean;
  isAdmin: boolean;
  onDelete: () => void;
}) {
  const roleLabel =
    note.authorRole === "admin"
      ? "Admin"
      : note.authorRole === "supervisor"
        ? "Supervisor"
        : "Reviewer";
  const roleClass =
    note.authorRole === "admin"
      ? "bg-warning/15 text-warning border-warning/40"
      : note.authorRole === "supervisor"
        ? "bg-primary/15 text-primary border-primary/40"
        : "bg-muted text-muted-foreground border-border";
  return (
    <li
      className="rounded border border-border bg-card px-3 py-2 text-sm"
      data-testid={`note-item-${note.id}`}
    >
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="flex items-center gap-2 flex-wrap text-[11px]">
          <span
            className={cn(
              "uppercase tracking-wider px-1.5 py-0 rounded border font-display",
              roleClass,
            )}
          >
            {roleLabel}
          </span>
          <span className="font-mono text-muted-foreground">
            {note.authorEmail ?? "(deleted user)"}
          </span>
          <span className="text-muted-foreground">·</span>
          <span
            className="font-mono text-muted-foreground"
            title={new Date(note.createdAt).toLocaleString()}
          >
            {new Date(note.createdAt).toLocaleString()}
          </span>
          {note.punchId != null && !note.punchExists && (
            <span className="text-[10px] uppercase tracking-wider px-1 py-0 rounded border border-warning/40 bg-warning/10 text-warning">
              orphaned punch
            </span>
          )}
          {isAdmin && note.lastHiddenAt && (
            <span
              className="text-[10px] uppercase tracking-wider px-1 py-0 rounded border border-dashed border-muted-foreground/60 bg-muted/40 text-muted-foreground"
              title={`Previously hidden by ${note.lastHiddenByEmail ?? "(deleted user)"} at ${new Date(note.lastHiddenAt).toLocaleString()}`}
              data-testid={`note-previously-hidden-${note.id}`}
            >
              previously hidden by {note.lastHiddenByEmail ?? "(deleted user)"}{" "}
              · {new Date(note.lastHiddenAt).toLocaleString()}
            </span>
          )}
        </div>
        {canDelete && (
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6 text-destructive hover:text-destructive hover:bg-destructive/10"
            onClick={onDelete}
            title="Hide note (admin only)"
            data-testid={`button-delete-note-${note.id}`}
          >
            <X className="h-3 w-3" />
          </Button>
        )}
      </div>
      <p className="whitespace-pre-wrap text-foreground/90 leading-snug">
        {note.body}
      </p>
    </li>
  );
}

function ShortcutRow({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-foreground">{label}</span>
      <div className="flex items-center gap-1">
        {keys.map((k, i) => (
          <kbd
            key={i}
            className="px-1.5 py-0.5 rounded border border-border bg-muted font-mono text-xs min-w-[1.5rem] text-center"
          >
            {k}
          </kbd>
        ))}
      </div>
    </div>
  );
}

function SourceBadge({ source }: { source: "Driver" | "Customer" | string }) {
  const isDriver = source === "Driver";
  return (
    <span
      className={cn(
        "inline-block text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-sm border",
        isDriver
          ? "bg-sidebar text-sidebar-foreground border-sidebar"
          : "bg-primary text-primary-foreground border-primary",
      )}
    >
      {source}
    </span>
  );
}

/**
 * Live "what-if" panel rendered inside the Add-Manual-Punch dialog. Shows
 * the duration this draft will land at, the new daily total, and the new
 * weekly RT/OT split — all computed by the server's hours engine via
 * `/preview-punch` so the numbers match the post-save dashboard exactly.
 *
 * The overlap warning surfaces same-source punches whose [in, out] window
 * intersects the draft by more than 10 minutes. This makes the
 * "supplements, never overwrites" promise concrete: the dispatcher sees
 * the conflicting row before they save, with full date/time context.
 */
function PreviewPanel({
  preview,
  onViewOverlap,
}: {
  onViewOverlap?: (id: number) => void;
  preview: {
    valid: boolean;
    invalidReason?: string | null;
    hours: number;
    dailyTotalAfter: { date: string; totalHours: number };
    weekly: {
      totalHours: number;
      regularHours: number;
      overtimeHours: number;
    };
    overlaps: Array<{
      id: number;
      source: "Driver" | "Customer";
      date: string;
      clockIn: string;
      clockOut: string;
      overlapMinutes: number;
    }>;
  } | null;
}) {
  if (!preview) {
    return (
      <div className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
        Fill in date, clock in, and clock out to preview the impact on this driver's day and week.
      </div>
    );
  }
  if (!preview.valid) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive flex items-start gap-2">
        <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        <span>{preview.invalidReason || "Invalid punch"}</span>
      </div>
    );
  }
  const ot = preview.weekly.overtimeHours;
  return (
    <div className="space-y-2">
      <div
        className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs"
        data-testid="preview-panel"
      >
        <div className="font-display font-semibold text-foreground mb-1">Preview</div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono">
          <dt className="text-muted-foreground">Duration</dt>
          <dd className="text-right" data-testid="preview-hours">
            {preview.hours.toFixed(2)}h
          </dd>
          <dt className="text-muted-foreground">New daily total ({preview.dailyTotalAfter.date})</dt>
          <dd className="text-right" data-testid="preview-daily-total">
            {preview.dailyTotalAfter.totalHours.toFixed(2)}h
          </dd>
          <dt className="text-muted-foreground">New weekly RT</dt>
          <dd className="text-right" data-testid="preview-weekly-rt">
            {preview.weekly.regularHours.toFixed(2)}h
          </dd>
          <dt className="text-muted-foreground">New weekly OT</dt>
          <dd
            className={cn(
              "text-right",
              ot > 0.005 ? "text-warning font-semibold" : undefined,
            )}
            data-testid="preview-weekly-ot"
          >
            {ot.toFixed(2)}h
          </dd>
        </dl>
      </div>
      {preview.overlaps.length > 0 && (
        <div
          className="rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-xs"
          data-testid="preview-overlap-warning"
        >
          <div className="flex items-start gap-2 text-warning-foreground">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-warning" />
            <div className="flex-1">
              <div className="font-semibold text-foreground">
                Overlaps {preview.overlaps.length} existing {preview.overlaps[0].source.toLowerCase()} punch{preview.overlaps.length === 1 ? "" : "es"}
              </div>
              <div className="text-muted-foreground mt-0.5">
                Saving will keep both — review the times below to make sure that's intentional.
              </div>
              <ul className="mt-1.5 space-y-0.5 font-mono text-[11px]">
                {preview.overlaps.slice(0, 3).map((o) => (
                  <li key={o.id} className="text-foreground flex items-center gap-2">
                    <span>
                      {o.date} · {o.clockIn.replace(/^\d{4}-\d{2}-\d{2}\s+/, "")} – {o.clockOut.replace(/^\d{4}-\d{2}-\d{2}\s+/, "")}
                      <span className="text-muted-foreground"> ({o.overlapMinutes}m overlap)</span>
                    </span>
                    {onViewOverlap && (
                      <button
                        type="button"
                        onClick={() => onViewOverlap(o.id)}
                        className="text-[10px] uppercase tracking-wider text-primary hover:underline focus:outline-none focus:underline"
                        data-testid={`view-overlap-${o.id}`}
                      >
                        View
                      </button>
                    )}
                  </li>
                ))}
                {preview.overlaps.length > 3 && (
                  <li className="text-muted-foreground">…and {preview.overlaps.length - 3} more</li>
                )}
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
