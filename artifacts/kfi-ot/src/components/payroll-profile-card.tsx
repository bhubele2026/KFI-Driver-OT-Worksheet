import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useGetDriverPayrollProfile,
  useUpdateDriverPayrollProfile,
  getGetDriverPayrollProfileQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Edit2, Save, X, DollarSign, ChevronDown, AlertTriangle } from "lucide-react";

interface Props {
  kfiId: string;
  canEdit: boolean;
}

type FieldDef = {
  key:
    | "ssn"
    | "zenopleCustomer"
    | "jobId"
    | "personId"
    | "assignmentId"
    | "rtPayRate"
    | "rtBillRate"
    | "otPayRate"
    | "otBillRate"
    | "driverRtPayRate"
    | "driverRtBillRate"
    | "driverOtPayRate"
    | "driverOtBillRate";
  label: string;
  kind: "string" | "int" | "money";
};

const RATE_FIELDS: FieldDef[] = [
  { key: "rtPayRate", label: "RT Pay", kind: "money" },
  { key: "rtBillRate", label: "RT Bill", kind: "money" },
  { key: "otPayRate", label: "OT Pay", kind: "money" },
  { key: "otBillRate", label: "OT Bill", kind: "money" },
  { key: "driverRtPayRate", label: "Driver RT Pay", kind: "money" },
  { key: "driverRtBillRate", label: "Driver RT Bill", kind: "money" },
  { key: "driverOtPayRate", label: "Driver OT Pay", kind: "money" },
  { key: "driverOtBillRate", label: "Driver OT Bill", kind: "money" },
];

const IDENTIFIER_FIELDS: FieldDef[] = [
  { key: "ssn", label: "SSN", kind: "string" },
  { key: "zenopleCustomer", label: "Zenople Customer", kind: "string" },
  { key: "jobId", label: "JobId", kind: "int" },
  { key: "personId", label: "PersonId", kind: "int" },
  { key: "assignmentId", label: "AssignmentId", kind: "int" },
];

const FIELDS: FieldDef[] = [...RATE_FIELDS, ...IDENTIFIER_FIELDS];

type FormState = Record<string, string>;

function toForm(p: unknown): FormState {
  const f: FormState = {};
  const obj = (p ?? {}) as Record<string, unknown>;
  for (const fd of FIELDS) {
    const v = obj[fd.key];
    f[fd.key] = v == null ? "" : String(v);
  }
  return f;
}

export function PayrollProfileCard({ kfiId, canEdit }: Props) {
  const { t } = useTranslation();
  const { data: profile } = useGetDriverPayrollProfile(kfiId);
  const update = useUpdateDriverPayrollProfile();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<FormState>(toForm(profile));
  // Open by default: these five now decide the export's Customer/Person
  // columns outright (Zenople no longer overwrites them), so they need to be
  // visible rather than buried behind a disclosure.
  const [identifiersOpen, setIdentifiersOpen] = useState(true);

  useEffect(() => {
    if (!editing) setForm(toForm(profile));
  }, [profile, editing]);

  const handleSave = () => {
    const body: Record<string, string | number | null> = {};
    for (const fd of FIELDS) {
      const raw = form[fd.key]?.trim() ?? "";
      if (raw === "") {
        body[fd.key] = null;
        continue;
      }
      if (fd.kind === "int") {
        const n = Number.parseInt(raw, 10);
        if (Number.isNaN(n)) {
          toast({
            title: t("payrollProfile.invalidValue"),
            description: t("payrollProfile.mustBeInteger", { label: fd.label }),
            variant: "destructive",
          });
          return;
        }
        body[fd.key] = n;
      } else if (fd.kind === "money") {
        const n = Number.parseFloat(raw);
        if (Number.isNaN(n)) {
          toast({
            title: t("payrollProfile.invalidValue"),
            description: t("payrollProfile.mustBeNumber", { label: fd.label }),
            variant: "destructive",
          });
          return;
        }
        body[fd.key] = n;
      } else {
        body[fd.key] = raw;
      }
    }
    update.mutate(
      { kfiId, data: body },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getGetDriverPayrollProfileQueryKey(kfiId),
          });
          setEditing(false);
          toast({ title: t("payrollProfile.savedTitle") });
        },
        onError: (err) => {
          toast({
            title: t("payrollProfile.saveFailedTitle"),
            description: err instanceof Error ? err.message : String(err),
            variant: "destructive",
          });
        },
      },
    );
  };

  const fmtView = (
    v: number | string | null | undefined,
    kind: "string" | "int" | "money",
  ): string => {
    if (v == null || v === "") return "—";
    if (kind === "money") {
      const n = typeof v === "number" ? v : Number.parseFloat(String(v));
      if (Number.isNaN(n)) return String(v);
      return `$${n.toFixed(2)}`;
    }
    return String(v);
  };

  // A rate is "known" only when a value is on file — zeros are deliberate
  // (driver-bill rates are legitimately $0), nulls mean nobody entered it.
  const missingRateFields = RATE_FIELDS.filter((fd) => {
    const v = (profile as Record<string, unknown> | undefined)?.[fd.key];
    return v == null || v === "";
  });

  const renderEditInputs = (fields: FieldDef[]) => (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
      {fields.map((fd) => (
        <div key={fd.key} className="space-y-1">
          <Label htmlFor={`pp-${fd.key}`} className="text-xs">
            {fd.label}
          </Label>
          <Input
            id={`pp-${fd.key}`}
            value={form[fd.key] ?? ""}
            onChange={(e) =>
              setForm((s) => ({ ...s, [fd.key]: e.target.value }))
            }
            className="fin-num text-sm h-8"
            data-testid={`input-payroll-${fd.key}`}
          />
        </div>
      ))}
    </div>
  );

  return (
    <Card data-testid="card-payroll-profile">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-display tracking-tight flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <DollarSign className="h-4 w-4 text-primary" />
            {t("payrollProfile.cardTitle")}
          </span>
          {canEdit ? (
            editing ? (
              <span className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setEditing(false)}
                  data-testid="button-cancel-payroll-profile"
                >
                  <X className="h-4 w-4 mr-1" /> {t("common.cancel")}
                </Button>
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={update.isPending}
                  data-testid="button-save-payroll-profile"
                >
                  <Save className="h-4 w-4 mr-1" /> {t("common.save")}
                </Button>
              </span>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setEditing(true)}
                data-testid="button-edit-payroll-profile"
              >
                <Edit2 className="h-4 w-4 mr-1" /> {t("common.edit")}
              </Button>
            )
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        {!editing && missingRateFields.length > 0 ? (
          <div
            className="mb-3 flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
            data-testid="banner-payroll-needs-info"
          >
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <div className="text-xs">
              <span className="font-semibold">{t("payrollProfile.needsInfo")}</span>
              <span className="text-[11px] block opacity-80">
                {t("payrollProfile.needsInfoDetail", {
                  fields:
                    missingRateFields.length === RATE_FIELDS.length
                      ? t("payrollProfile.cardTitle")
                      : missingRateFields.map((f) => f.label).join(", "),
                })}
              </span>
            </div>
          </div>
        ) : null}
        {editing ? (
          <div className="space-y-4">
            {renderEditInputs(RATE_FIELDS)}
            <div className="pt-2 border-t border-border/50">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">
                {t("payrollProfile.identifiers")}
              </p>
              {renderEditInputs(IDENTIFIER_FIELDS)}
            </div>
          </div>
        ) : (
          <>
            <dl className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-2 text-sm">
              {RATE_FIELDS.map((fd) => (
                <div
                  key={fd.key}
                  className="flex justify-between items-baseline border-b border-border/50 pb-1"
                  data-testid={`row-payroll-${fd.key}`}
                >
                  <dt className="text-xs text-muted-foreground">{fd.label}</dt>
                  <dd className="fin-num">
                    {fmtView(
                      (profile as Record<string, unknown> | undefined)?.[
                        fd.key
                      ] as number | string | null | undefined,
                      fd.kind,
                    )}
                  </dd>
                </div>
              ))}
            </dl>
            <Collapsible
              open={identifiersOpen}
              onOpenChange={setIdentifiersOpen}
              className="mt-3"
            >
              <CollapsibleTrigger
                className="flex items-center gap-1 text-[11px] uppercase tracking-wide text-muted-foreground hover:text-foreground transition-colors"
                data-testid="button-toggle-identifiers"
              >
                <ChevronDown
                  className={`h-3 w-3 transition-transform ${identifiersOpen ? "rotate-0" : "-rotate-90"}`}
                />
                {t("payrollProfile.identifiers")}
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2">
                <dl className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-1 text-xs">
                  {IDENTIFIER_FIELDS.map((fd) => (
                    <div
                      key={fd.key}
                      className="flex justify-between items-baseline border-b border-border/30 pb-1"
                      data-testid={`row-payroll-${fd.key}`}
                    >
                      <dt className="text-[11px] text-muted-foreground">
                        {fd.label}
                      </dt>
                      <dd className="fin-num text-muted-foreground">
                        {fmtView(
                          (profile as Record<string, unknown> | undefined)?.[
                            fd.key
                          ] as number | string | null | undefined,
                          fd.kind,
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              </CollapsibleContent>
            </Collapsible>
          </>
        )}
        {profile?.updatedAt ? (
          <p className="mt-3 text-[11px] text-muted-foreground">
            {profile.updatedByEmail
              ? t("payrollProfile.lastUpdatedBy", {
                  date: new Date(profile.updatedAt).toLocaleString(),
                  email: profile.updatedByEmail,
                })
              : t("payrollProfile.lastUpdated", {
                  date: new Date(profile.updatedAt).toLocaleString(),
                })}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
