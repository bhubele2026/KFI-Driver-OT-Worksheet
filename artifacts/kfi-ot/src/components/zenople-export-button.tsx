import { useState } from "react";
import { useGetZenopleReadiness } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Download, AlertTriangle } from "lucide-react";

interface Props {
  weekStart: string;
}

export function ZenopleExportButton({ weekStart }: Props) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const { data: readiness, isLoading, refetch } =
    useGetZenopleReadiness(weekStart);

  const handleClick = async () => {
    const fresh = await refetch();
    const r = fresh.data ?? readiness;
    if (!r) {
      toast({
        title: "Could not check Zenople readiness",
        variant: "destructive",
      });
      return;
    }
    if (!r.ready) {
      setOpen(true);
      return;
    }
    window.open(
      `${import.meta.env.BASE_URL}api/weeks/${weekStart}/zenople-export`,
      "_self",
    );
  };

  return (
    <>
      <Button
        variant="outline"
        onClick={handleClick}
        disabled={isLoading}
        data-testid="button-zenople-export"
        title="Download the Zenople xlsx for this week (admin)"
      >
        <Download className="mr-2 h-4 w-4" />
        Export to Zenople
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-testid="dialog-zenople-not-ready">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-warning" />
              Not ready to export
            </DialogTitle>
            <DialogDescription>
              {readiness
                ? `${readiness.driversReady} of ${readiness.driversTotal} drivers are ready. Fix the items below and try again.`
                : null}
            </DialogDescription>
          </DialogHeader>
          {readiness ? (
            <div className="space-y-3 text-sm">
              {readiness.unreviewedKfiIds.length > 0 ? (
                <div>
                  <div className="font-semibold mb-1">
                    Not yet reviewed ({readiness.unreviewedKfiIds.length}):
                  </div>
                  <ul className="list-disc pl-5 font-mono text-xs space-y-0.5 max-h-40 overflow-auto">
                    {readiness.unreviewedKfiIds.map((id) => (
                      <li key={id}>{id}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {readiness.missingProfileKfiIds.length > 0 ? (
                <div>
                  <div className="font-semibold mb-1">
                    Missing pay & bill profile fields (
                    {readiness.missingProfileKfiIds.length}):
                  </div>
                  <ul className="list-disc pl-5 text-xs space-y-0.5 max-h-40 overflow-auto">
                    {readiness.missingProfileKfiIds.map((m) => (
                      <li key={m.kfiId}>
                        <span className="font-mono">{m.kfiId}</span>
                        {m.missing && m.missing.length > 0 ? (
                          <span className="text-muted-foreground">
                            {" "}
                            — {m.missing.join(", ")}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button
              onClick={() => setOpen(false)}
              data-testid="button-zenople-not-ready-close"
            >
              Got it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
