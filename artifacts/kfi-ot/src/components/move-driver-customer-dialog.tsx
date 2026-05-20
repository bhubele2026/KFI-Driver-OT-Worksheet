import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import {
  useSetDriverCustomerOverride,
  useGetWeekSummary,
  getGetWeekSummaryQueryKey,
  getListDriverCustomerOverridesQueryKey,
} from "@workspace/api-client-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Loader2 } from "lucide-react";

interface MoveDriverCustomerDialogProps {
  weekStart: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  driver: {
    kfiId: string;
    name: string;
    customer: string;
    originalCustomer?: string | null;
  };
}

const CUSTOM_VALUE = "__custom__";

export function MoveDriverCustomerDialog({
  weekStart,
  open,
  onOpenChange,
  driver,
}: MoveDriverCustomerDialogProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: summary } = useGetWeekSummary(weekStart);
  const setOverride = useSetDriverCustomerOverride();

  const rosterCustomer = driver.originalCustomer ?? driver.customer;

  const knownCustomers = useMemo(() => {
    const set = new Set<string>();
    for (const g of summary?.customers ?? []) {
      if (g.customer && g.customer !== rosterCustomer) set.add(g.customer);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [summary?.customers, rosterCustomer]);

  const [picked, setPicked] = useState<string>("");
  const [customValue, setCustomValue] = useState<string>("");

  const effectiveTarget =
    picked === CUSTOM_VALUE ? customValue.trim() : picked.trim();
  const disabled =
    !effectiveTarget ||
    effectiveTarget === rosterCustomer ||
    setOverride.isPending;

  const reset = () => {
    setPicked("");
    setCustomValue("");
  };

  const handleSubmit = () => {
    if (!effectiveTarget) return;
    setOverride.mutate(
      {
        data: { kfiId: driver.kfiId, overrideCustomer: effectiveTarget },
      },
      {
        onSuccess: () => {
          qc.invalidateQueries({
            queryKey: getGetWeekSummaryQueryKey(weekStart),
          });
          qc.invalidateQueries({
            queryKey: getListDriverCustomerOverridesQueryKey(),
          });
          toast({
            title: t("moveDriverDialog.movedTitle", {
              name: driver.name,
              customer: effectiveTarget,
            }),
            description: t("moveDriverDialog.movedDesc"),
          });
          reset();
          onOpenChange(false);
        },
        onError: (err) =>
          toast({
            title: t("moveDriverDialog.moveFailed"),
            description: err instanceof Error ? err.message : t("errors.unknown"),
            variant: "destructive",
          }),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-md" data-testid="dialog-move-driver">
        <DialogHeader>
          <DialogTitle className="font-display">
            {t("moveDriverDialog.title")}
          </DialogTitle>
          <DialogDescription>
            {t("moveDriverDialog.descriptionBefore", { name: driver.name })}
            <span className="font-mono">{rosterCustomer}</span>
            {t("moveDriverDialog.descriptionAfter")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">
              {t("moveDriverDialog.moveTo")}
            </label>
            <Select value={picked} onValueChange={setPicked}>
              <SelectTrigger data-testid="select-move-customer">
                <SelectValue placeholder={t("moveDriverDialog.pickPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {knownCustomers.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
                <SelectItem value={CUSTOM_VALUE}>{t("moveDriverDialog.other")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {picked === CUSTOM_VALUE && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                {t("moveDriverDialog.customLabel")}
              </label>
              <Input
                value={customValue}
                onChange={(e) => setCustomValue(e.target.value)}
                placeholder={t("moveDriverDialog.customPlaceholder")}
                data-testid="input-move-customer-custom"
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={setOverride.isPending}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={disabled}
            data-testid="button-move-customer-confirm"
          >
            {setOverride.isPending && (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            )}
            {t("moveDriverDialog.moveButton")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
