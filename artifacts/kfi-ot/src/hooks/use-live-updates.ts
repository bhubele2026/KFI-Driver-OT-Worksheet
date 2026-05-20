import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetWeekSummaryQueryKey,
  getGetDriverWeekQueryKey,
  getGetCustomerUploadStatusQueryKey,
  getListDriverNotesQueryKey,
  getGetDriverWeekAuditQueryKey,
  getGetHiddenNotesUnseenCountQueryKey,
} from "@workspace/api-client-react";
import { subscribeRealtime, type RealtimeEvent } from "@/lib/realtime";
import { useToast } from "@/hooks/use-toast";

interface Args {
  weekStart: string | null | undefined;
  kfiId?: string | null;
  /** The currently signed-in user's email, so we can suppress self-noise toasts. */
  selfEmail?: string | null;
  /** Listen for and react to every event type. Pages opt-in to toasts. */
  enableToasts?: boolean;
}

/**
 * Live-updates wiring for any page that wants to react to other dispatchers'
 * edits within ~2s. Subscribes to the SSE stream for the given week (and
 * optional driver), then surgically invalidates the matching react-query
 * caches. Optionally emits toasts for lock/review changes so the dispatcher
 * isn't blindsided when a supervisor locks the row they were editing.
 */
export function useLiveUpdates({
  weekStart,
  kfiId,
  selfEmail,
  enableToasts,
}: Args): void {
  const qc = useQueryClient();
  const { toast } = useToast();
  const selfEmailRef = useRef(selfEmail);
  selfEmailRef.current = selfEmail;

  useEffect(() => {
    if (!weekStart) return;
    const unsub = subscribeRealtime({
      weekStart,
      kfiId: kfiId ?? null,
      handler: (event: RealtimeEvent) => {
        const isSelf =
          "actor" in event && event.actor?.email === selfEmailRef.current;

        switch (event.type) {
          case "punch-changed":
          case "review-changed":
          case "lock-changed":
            qc.invalidateQueries({
              queryKey: getGetWeekSummaryQueryKey(event.weekStart),
            });
            qc.invalidateQueries({
              queryKey: getGetDriverWeekQueryKey(event.weekStart, event.kfiId),
            });
            qc.invalidateQueries({
              queryKey: getGetDriverWeekAuditQueryKey(event.weekStart, event.kfiId),
            });
            // Scope lock/review toasts to the driver-week the dispatcher is
            // currently looking at. Cache invalidation still happens for any
            // event on the subscribed week so list views stay fresh, but
            // popping a toast for an unrelated driver while the user is
            // focused on a different one is noise.
            const eventMatchesCurrent = !kfiId || event.kfiId === kfiId;
            if (enableToasts && !isSelf && eventMatchesCurrent) {
              if (event.type === "lock-changed") {
                toast({
                  title: event.locked ? "Driver-week locked" : "Driver-week unlocked",
                  description: event.actor
                    ? `${event.actor.email} ${event.locked ? "locked" : "unlocked"} this row.`
                    : undefined,
                });
              } else if (event.type === "review-changed") {
                toast({
                  title:
                    event.status === "good"
                      ? "Marked reviewed (good)"
                      : event.status === "bad"
                        ? "Marked reviewed (needs fix)"
                        : "Review cleared",
                  description: event.actor?.email
                    ? `by ${event.actor.email}`
                    : undefined,
                });
              }
            }
            break;

          case "week-refreshed":
            qc.invalidateQueries({
              queryKey: getGetWeekSummaryQueryKey(event.weekStart),
            });
            if (kfiId) {
              qc.invalidateQueries({
                queryKey: getGetDriverWeekQueryKey(event.weekStart, kfiId),
              });
            }
            if (enableToasts && !isSelf) {
              toast({
                title: "Connecteam refreshed",
                description: event.actor?.email
                  ? `by ${event.actor.email}`
                  : undefined,
              });
            }
            break;

          case "week-reset":
            // A destructive admin reset wipes data for the entire week, so
            // invalidate every cache surface this page might be looking at.
            qc.invalidateQueries({
              queryKey: getGetWeekSummaryQueryKey(event.weekStart),
            });
            qc.invalidateQueries({
              queryKey: getGetCustomerUploadStatusQueryKey(event.weekStart),
            });
            if (kfiId) {
              qc.invalidateQueries({
                queryKey: getGetDriverWeekQueryKey(event.weekStart, kfiId),
              });
              qc.invalidateQueries({
                queryKey: getGetDriverWeekAuditQueryKey(event.weekStart, kfiId),
              });
              qc.invalidateQueries({
                queryKey: getListDriverNotesQueryKey(event.weekStart, kfiId),
              });
            }
            if (enableToasts && !isSelf) {
              toast({
                title: "Week reset",
                description: event.actor?.email
                  ? `${event.actor.email} wiped ${event.punchesDeleted} punch${event.punchesDeleted === 1 ? "" : "es"} (${event.scope}).`
                  : `${event.punchesDeleted} punch${event.punchesDeleted === 1 ? "" : "es"} wiped (${event.scope}).`,
                variant: "destructive",
              });
            }
            break;

          case "driver-customer-reset":
          case "driver-connecteam-remove":
            qc.invalidateQueries({
              queryKey: getGetWeekSummaryQueryKey(event.weekStart),
            });
            qc.invalidateQueries({
              queryKey: getGetDriverWeekQueryKey(event.weekStart, event.kfiId),
            });
            qc.invalidateQueries({
              queryKey: getGetDriverWeekAuditQueryKey(
                event.weekStart,
                event.kfiId,
              ),
            });
            break;

          case "customer-upload":
            qc.invalidateQueries({
              queryKey: getGetWeekSummaryQueryKey(event.weekStart),
            });
            qc.invalidateQueries({
              queryKey: getGetCustomerUploadStatusQueryKey(event.weekStart),
            });
            if (kfiId) {
              qc.invalidateQueries({
                queryKey: getGetDriverWeekQueryKey(event.weekStart, kfiId),
              });
            }
            if (enableToasts && !isSelf) {
              toast({
                title: `${event.customer} file uploaded`,
                description: event.actor?.email
                  ? `by ${event.actor.email}`
                  : undefined,
              });
            }
            break;

          case "payroll-profile":
            // A different dispatcher updated the pay/bill rates on a driver;
            // refresh the rates card and the week's readiness banner so the
            // Export to Zenople button updates without a manual reload.
            qc.invalidateQueries({
              queryKey: [`/api/drivers/${event.kfiId}/payroll-profile`],
            });
            if (weekStart) {
              qc.invalidateQueries({
                queryKey: [`/api/weeks/${weekStart}/zenople-readiness`],
              });
            }
            break;

          case "note-changed":
            qc.invalidateQueries({
              queryKey: getListDriverNotesQueryKey(event.weekStart, event.kfiId),
            });
            qc.invalidateQueries({
              queryKey: getGetWeekSummaryQueryKey(event.weekStart),
            });
            // Admin header badge for unseen hidden notes; soft-delete or
            // restore changes the unseen count, so keep it live too.
            qc.invalidateQueries({
              queryKey: getGetHiddenNotesUnseenCountQueryKey(),
            });
            break;

          case "reconnect":
            // SSE went down and came back; we may have missed events.
            // Invalidate every cache surface this hook owns so the page
            // resyncs against the server source of truth.
            qc.invalidateQueries({
              queryKey: getGetWeekSummaryQueryKey(event.weekStart),
            });
            if (event.kfiId) {
              qc.invalidateQueries({
                queryKey: getGetDriverWeekQueryKey(event.weekStart, event.kfiId),
              });
              qc.invalidateQueries({
                queryKey: getGetDriverWeekAuditQueryKey(event.weekStart, event.kfiId),
              });
              qc.invalidateQueries({
                queryKey: getListDriverNotesQueryKey(event.weekStart, event.kfiId),
              });
            }
            qc.invalidateQueries({
              queryKey: getGetCustomerUploadStatusQueryKey(event.weekStart),
            });
            qc.invalidateQueries({
              queryKey: getGetHiddenNotesUnseenCountQueryKey(),
            });
            break;

          // presence / editing / ping are consumed by dedicated hooks below.
          default:
            break;
        }
      },
    });
    return () => {
      unsub();
    };
  }, [weekStart, kfiId, enableToasts, qc, toast]);
}
