import { useEffect, useState } from "react";
import { guardedFetch } from "@/lib/session";

/**
 * The pay-period control. Only REAL pay dates are selectable — Fridays, or
 * the Thursday before when that Friday is a bank holiday (Brad, 2026-09-01:
 * "make sure only fridays, and thursdays if there is a holiday on friday,
 * are only clickable"). The list comes from the server's pay-date law, not
 * from a free-typing calendar input, so a scrubbed date can never reach the
 * period API again.
 */
export type PayDateOption = {
  payDate: string;
  label: string;
  holidayShifted: boolean;
};

type PayDatesPayload = { payDates: PayDateOption[]; current: string };

const base = import.meta.env.BASE_URL;

// One fetch per session, shared by every payroll page's picker.
let cached: Promise<PayDatesPayload> | null = null;
function loadPayDates(): Promise<PayDatesPayload> {
  if (!cached) {
    cached = guardedFetch(`${base}api/payroll-run/pay-dates`)
      .then((r) => (r.ok ? (r.json() as Promise<PayDatesPayload>) : Promise.reject(new Error(String(r.status)))))
      .catch((e) => {
        cached = null; // a blip must not pin every picker to empty for the session
        throw e;
      });
  }
  return cached;
}

export function usePayDates(): PayDatesPayload | null {
  const [data, setData] = useState<PayDatesPayload | null>(null);
  useEffect(() => {
    let alive = true;
    loadPayDates().then((d) => alive && setData(d)).catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return data;
}

export function PayDatePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (payDate: string) => void;
}) {
  const data = usePayDates();
  const options = data?.payDates ?? [];
  const idx = options.findIndex((o) => o.payDate === value);

  // The pages initialise from local Friday arithmetic; in a holiday week the
  // real pay day is the Thursday. Reconcile once the server's list arrives.
  useEffect(() => {
    if (!data) return;
    if (options.some((o) => o.payDate === value)) return;
    onChange(data.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const step = (dir: -1 | 1) => {
    const next = options[idx + dir];
    if (next) onChange(next.payDate);
  };

  const arrow =
    "press grid h-8 w-8 place-items-center rounded-control text-brand-navy ring-1 ring-brand-line " +
    "hover:bg-brand-tint disabled:opacity-30 disabled:hover:bg-transparent";

  return (
    <div className="flex items-center gap-1.5">
      <span className="mr-0.5 text-label text-neutral-500">Pay period</span>
      <button type="button" className={arrow} aria-label="Previous pay period"
        disabled={idx <= 0} onClick={() => step(-1)}>
        ‹
      </button>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="fin-num press rounded-control border border-brand-line bg-white px-2.5 py-1.5 text-body text-brand-ink shadow-rest hover:border-brand-navy/30"
        aria-label="Pay period"
      >
        {idx === -1 && <option value={value}>{value}</option>}
        {options.map((o) => (
          <option key={o.payDate} value={o.payDate}>
            {o.label}
            {o.holidayShifted ? " · pays Thu" : ""}
          </option>
        ))}
      </select>
      <button type="button" className={arrow} aria-label="Next pay period"
        disabled={idx === -1 || idx >= options.length - 1} onClick={() => step(1)}>
        ›
      </button>
    </div>
  );
}
