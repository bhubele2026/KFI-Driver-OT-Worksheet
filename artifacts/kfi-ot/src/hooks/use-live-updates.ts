import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetWeekSummaryQueryKey,
  getGetDriverWeekQueryKey,
  getGetCustomerUploadStatusQueryKey,
  getListDriverNotesQueryKey,
  getGetDriverWeekAuditQueryKey,
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
            if (enableToasts && !isSelf) {
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

          case "note-changed":
            qc.invalidateQueries({
              queryKey: getListDriverNotesQueryKey(event.weekStart, event.kfiId),
            });
            qc.invalidateQueries({
              queryKey: getGetWeekSummaryQueryKey(event.weekStart),
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
