import { useEffect, useRef, useState } from "react";
import {
  useConfirmNewCustomerFile,
  useGetAllowedTimezones,
} from "@workspace/api-client-react";
import { formatPersonName } from "@/lib/format-name";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import {
  Loader2,
  Sparkles,
  AlertCircle,
  ArrowLeft,
} from "lucide-react";

const UNMAPPED = "__unmapped__";

interface ExtractedRow {
  driverNameOnDoc: string;
  badgeOrId?: string | null;
  date: string;
  timeIn?: string | null;
  timeOut?: string | null;
  hours?: number | null;
}
interface DriverMatch {
  kfiId: string;
  name: string;
  customer: string;
  confidence: number;
}
interface Suggestion {
  driverNameOnDoc: string;
  badgeOrId?: string | null;
  savedKfiId?: string | null;
  matches: DriverMatch[];
}
interface ExtractPreview {
  customer: string;
  weekStart: string;
  rows: ExtractedRow[];
  suggestions: Suggestion[];
  sampleId: number;
}

function errMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return fallback;
}

export function NewCustomerDialog({
  weekStart,
  open,
  onOpenChange,
  onImported,
  initialFile,
}: {
  weekStart: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
  initialFile?: File | null;
}) {
  const { toast } = useToast();
  const confirmMut = useConfirmNewCustomerFile();
  const fileRef = useRef<HTMLInputElement>(null);

  const [customer, setCustomer] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ExtractPreview | null>(null);
  const [editedRows, setEditedRows] = useState<ExtractedRow[]>([]);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [forgottenAliases, setForgottenAliases] = useState<Set<string>>(
    new Set(),
  );
  const [forgettingName, setForgettingName] = useState<string | null>(null);
  const [dispTz, setDispTz] = useState<string>("__auto__");
  const { data: allowedTzs } = useGetAllowedTimezones();

  useEffect(() => {
    if (!open) {
      setCustomer("");
      setFile(null);
      setExtracting(false);
      setExtractError(null);
      setPreview(null);
      setEditedRows([]);
      setExcluded(new Set());
      setMapping({});
      setForgottenAliases(new Set());
      setForgettingName(null);
      setDispTz("__auto__");
    } else if (initialFile) {
      setFile(initialFile);
    }
  }, [open, initialFile]);

  const forgetAlias = async (nameOnDoc: string) => {
    if (!preview) return;
    setForgettingName(nameOnDoc);
    try {
      const url = `${import.meta.env.BASE_URL}api/customer-aliases?customer=${encodeURIComponent(preview.customer)}&nameOnDoc=${encodeURIComponent(nameOnDoc)}`;
      const res = await fetch(url, { method: "DELETE", credentials: "include" });
      if (!res.ok && res.status !== 204) {
        throw new Error(`HTTP ${res.status}`);
      }
      setForgottenAliases((s) => {
        const next = new Set(s);
        next.add(nameOnDoc);
        return next;
      });
      toast({
        title: "Mapping forgotten",
        description: `Will ask again next time "${nameOnDoc}" appears on a ${preview.customer} file.`,
      });
    } catch (err) {
      toast({
        title: "Could not forget mapping",
        description: errMessage(err, "Network error"),
        variant: "destructive",
      });
    } finally {
      setForgettingName(null);
    }
  };

  const runExtract = async () => {
    if (!file || !customer.trim()) return;
    setExtracting(true);
    setExtractError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("customer", customer.trim());
      const res = await fetch(
        `${import.meta.env.BASE_URL}api/weeks/${weekStart}/extract-new-customer`,
        { method: "POST", credentials: "include", body: fd },
      );
      const body = (await res.json().catch(() => null)) as
        | (ExtractPreview & { error?: string })
        | null;
      if (!res.ok || !body) {
        throw new Error(body?.error ?? "Could not extract rows");
      }
      setPreview(body);
      setEditedRows(body.rows);
      const initialMap: Record<string, string> = {};
      for (const s of body.suggestions) {
        // Prefer a previously-saved alias; fall back to the top fuzzy match.
        if (s.savedKfiId) {
          initialMap[s.driverNameOnDoc] = s.savedKfiId;
          continue;
        }
        const top = s.matches[0];
        initialMap[s.driverNameOnDoc] =
          top && top.confidence >= 0.6 ? top.kfiId : UNMAPPED;
      }
      setMapping(initialMap);
    } catch (err) {
      setExtractError(errMessage(err, "Could not extract rows"));
    } finally {
      setExtracting(false);
    }
  };

  const updateRow = (idx: number, patch: Partial<ExtractedRow>) => {
    setEditedRows((rows) =>
      rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)),
    );
  };

  const handleConfirm = () => {
    if (!preview) return;
    const cleanMapping: Record<string, string | null> = {};
    for (const [name, val] of Object.entries(mapping)) {
      cleanMapping[name] = val === UNMAPPED ? null : val;
    }
    // Preserve original row indices so the server's `excludedIndices` line
    // up with the rows we send. We filter out structurally invalid rows
    // (missing date or both time/hours) AFTER mapping the indices, then
    // translate any "kept" exclusions through the same filter so the index
    // arithmetic is correct.
    const keptRows: Array<{
      payload: {
        driverNameOnDoc: string;
        date: string;
        clockIn: string;
        clockOut: string;
        hours: number | null;
      };
      originalIndex: number;
    }> = [];
    editedRows.forEach((r, idx) => {
      if (!r.date) return;
      if (!(r.timeIn || r.hours)) return;
      if (!(r.timeOut || r.hours)) return;
      keptRows.push({
        payload: {
          driverNameOnDoc: r.driverNameOnDoc,
          date: r.date,
          clockIn: r.timeIn ?? "",
          clockOut: r.timeOut ?? "",
          hours: r.hours ?? null,
        },
        originalIndex: idx,
      });
    });
    const payloadRows = keptRows.map((k) => k.payload);
    const excludedIndices = keptRows
      .map((k, newIdx) => (excluded.has(k.originalIndex) ? newIdx : -1))
      .filter((i) => i >= 0);
    confirmMut.mutate(
      {
        weekStart,
        data: {
          customer: preview.customer,
          sampleId: preview.sampleId,
          mapping: cleanMapping,
          rows: payloadRows,
          excludedIndices,
          ...(dispTz !== "__auto__" ? { dispTz } : {}),
        },
      },
      {
        onSuccess: (data) => {
          toast({
            title: `${data.customer} imported`,
            description: `Added ${data.imported} punches${
              data.skippedUnmapped > 0
                ? ` · skipped ${data.skippedUnmapped} (${data.unmappedNames.join(", ") || "incomplete rows"})`
                : ""
            }.`,
          });
          onImported();
          onOpenChange(false);
        },
        onError: (err) => {
          toast({
            title: "Import failed",
            description: errMessage(err, "Could not save punches"),
            variant: "destructive",
          });
        },
      },
    );
  };

  const goBack = () => {
    setPreview(null);
    setEditedRows([]);
    setExcluded(new Set());
    setMapping({});
  };

  const toggleExclude = (idx: number) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const hasPreview = preview !== null;
  const keptCount = editedRows.length - excluded.size;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl w-[95vw] max-h-[90vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-6 pt-6 pb-3 border-b border-border">
          <DialogTitle className="flex items-center gap-2 font-display">
            <Sparkles className="h-5 w-5 text-primary" />
            New customer file (AI extract)
          </DialogTitle>
          <DialogDescription>
            For one-off customer files we don't have a parser for. Nothing is
            saved until you confirm.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {!hasPreview ? (
            <div className="space-y-4 max-w-md">
              <div className="space-y-1.5">
                <Label htmlFor="ncf-customer">Customer name</Label>
                <Input
                  id="ncf-customer"
                  placeholder="e.g. Acme Logistics"
                  value={customer}
                  onChange={(e) => setCustomer(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  This name will be saved as the customer for every imported
                  punch.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ncf-file">
                  File (.pdf, .xlsx, or a photo of the timesheet)
                </Label>
                <Input
                  id="ncf-file"
                  ref={fileRef}
                  type="file"
                  accept=".pdf,.xlsx,.xls,.jpg,.jpeg,.png,.heic,.heif,.webp"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </div>
              {extractError && (
                <div className="flex items-start gap-2 rounded border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>{extractError}</span>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-6">
              <div className="rounded border border-border/60 bg-muted/30 px-3 py-2 text-sm flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-semibold">{preview.customer}</span>
                  <span className="text-muted-foreground">
                    {" "}· week of {preview.weekStart} · {keptCount} of{" "}
                    {editedRows.length} rows selected
                    {excluded.size > 0 ? ` · ${excluded.size} excluded` : ""}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    Tz
                  </Label>
                  <Select value={dispTz} onValueChange={setDispTz}>
                    <SelectTrigger
                      className="h-7 w-[180px] text-xs"
                      data-testid="select-new-customer-tz"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__auto__" className="text-xs">
                        Auto (per driver/customer)
                      </SelectItem>
                      {(allowedTzs?.allowed ?? []).map((tz) => (
                        <SelectItem key={tz} value={tz} className="text-xs">
                          {tz}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <section>
                <h4 className="font-display font-semibold text-sm mb-2">
                  Driver mapping
                </h4>
                <p className="text-xs text-muted-foreground mb-3">
                  Each name on the document is matched to a Connecteam driver.
                  Leave as "Skip" to drop that driver's rows.
                </p>
                <div className="border border-border rounded overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name on document</TableHead>
                        <TableHead>Badge / ID</TableHead>
                        <TableHead>Connecteam driver</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {preview.suggestions.map((s) => (
                        <TableRow key={s.driverNameOnDoc}>
                          <TableCell className="font-medium">
                            <div className="flex flex-col">
                              <span>{s.driverNameOnDoc}</span>
                              {forgottenAliases.has(s.driverNameOnDoc) ? (
                                <span className="text-[10px] text-muted-foreground">
                                  Saved mapping forgotten
                                </span>
                              ) : s.savedKfiId ? (
                                <button
                                  type="button"
                                  className="self-start text-[10px] text-primary hover:underline disabled:opacity-50"
                                  onClick={() =>
                                    forgetAlias(s.driverNameOnDoc)
                                  }
                                  disabled={forgettingName === s.driverNameOnDoc}
                                >
                                  {forgettingName === s.driverNameOnDoc
                                    ? "Forgetting…"
                                    : "Forget saved mapping"}
                                </button>
                              ) : null}
                            </div>
                          </TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">
                            {s.badgeOrId ?? "—"}
                          </TableCell>
                          <TableCell>
                            <Select
                              value={mapping[s.driverNameOnDoc] ?? UNMAPPED}
                              onValueChange={(v) =>
                                setMapping((m) => ({
                                  ...m,
                                  [s.driverNameOnDoc]: v,
                                }))
                              }
                            >
                              <SelectTrigger className="w-full max-w-md h-8 text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value={UNMAPPED}>
                                  — Skip / unmapped —
                                </SelectItem>
                                {s.matches.map((m) => (
                                  <SelectItem key={m.kfiId} value={m.kfiId}>
                                    <span className="flex items-center gap-2">
                                      <span>{formatPersonName(m.name)}</span>
                                      <span className="text-muted-foreground font-mono text-[10px]">
                                        {m.kfiId}
                                      </span>
                                      {s.savedKfiId === m.kfiId &&
                                      !forgottenAliases.has(s.driverNameOnDoc) ? (
                                        <Badge className="text-[10px]">
                                          saved
                                        </Badge>
                                      ) : (
                                        <Badge
                                          variant="outline"
                                          className="text-[10px]"
                                        >
                                          {Math.round(m.confidence * 100)}%
                                        </Badge>
                                      )}
                                    </span>
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </section>

              <section>
                <h4 className="font-display font-semibold text-sm mb-2">
                  Extracted rows
                </h4>
                <p className="text-xs text-muted-foreground mb-3">
                  Untick "Keep" to drop a row. Rows whose driver is unmapped
                  are also skipped automatically.
                </p>
                <div className="border border-border rounded overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10">Keep</TableHead>
                        <TableHead>Driver (on doc)</TableHead>
                        <TableHead>Date</TableHead>
                        <TableHead>In</TableHead>
                        <TableHead>Out</TableHead>
                        <TableHead className="text-right">Hours</TableHead>
                        <TableHead>Mapped to</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {editedRows.map((r, idx) => {
                        const target = mapping[r.driverNameOnDoc] ?? UNMAPPED;
                        const matchedName =
                          target === UNMAPPED
                            ? null
                            : preview.suggestions
                                .find((s) => s.driverNameOnDoc === r.driverNameOnDoc)
                                ?.matches.find((m) => m.kfiId === target)?.name ?? null;
                        const targetLabel =
                          target === UNMAPPED
                            ? "Skip"
                            : matchedName
                              ? formatPersonName(matchedName)
                              : target;
                        const unmapped = target === UNMAPPED;
                        const isExcluded = excluded.has(idx);
                        const dim = unmapped || isExcluded;
                        return (
                          <TableRow
                            key={idx}
                            data-testid={`row-new-customer-${idx}`}
                            className={dim ? "opacity-50" : ""}
                          >
                            <TableCell>
                              <Checkbox
                                checked={!isExcluded}
                                onCheckedChange={() => toggleExclude(idx)}
                                data-testid={`checkbox-keep-new-${idx}`}
                                aria-label={`Keep row ${idx + 1}`}
                              />
                            </TableCell>
                            <TableCell className="text-xs font-medium">
                              {formatPersonName(r.driverNameOnDoc)}
                            </TableCell>
                            <TableCell>
                              <Input
                                value={r.date}
                                onChange={(e) =>
                                  updateRow(idx, { date: e.target.value })
                                }
                                className="h-7 font-mono text-xs w-[110px]"
                              />
                            </TableCell>
                            <TableCell>
                              <Input
                                value={r.timeIn ?? ""}
                                onChange={(e) =>
                                  updateRow(idx, { timeIn: e.target.value })
                                }
                                placeholder="7:00 AM"
                                className="h-7 font-mono text-xs w-[90px]"
                              />
                            </TableCell>
                            <TableCell>
                              <Input
                                value={r.timeOut ?? ""}
                                onChange={(e) =>
                                  updateRow(idx, { timeOut: e.target.value })
                                }
                                placeholder="3:30 PM"
                                className="h-7 font-mono text-xs w-[90px]"
                              />
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs">
                              {r.hours != null ? r.hours.toFixed(2) : "—"}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {targetLabel}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </section>
            </div>
          )}
        </div>

        <DialogFooter className="px-6 py-3 border-t border-border bg-muted/20">
          {!hasPreview ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                onClick={runExtract}
                disabled={!file || !customer.trim() || extracting}
              >
                {extracting ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="mr-2 h-4 w-4" />
                )}
                Extract with AI
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={goBack}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                Pick a different file
              </Button>
              <div className="flex-1" />
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleConfirm}
                disabled={confirmMut.isPending}
              >
                {confirmMut.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Confirm import
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
