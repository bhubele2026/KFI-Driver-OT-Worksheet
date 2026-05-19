import { Pencil } from "lucide-react";

interface Props {
  emails: string[];
}

/**
 * Inline "X is editing" hint placed next to a row. Renders nothing when
 * no other user has an active edit claim — the row stays visually clean
 * for the common case.
 */
export function EditingIndicator({ emails }: Props) {
  if (emails.length === 0) return null;
  const label =
    emails.length === 1
      ? `${emails[0]} is editing`
      : `${emails.length} dispatchers editing`;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-mono text-amber-700 dark:text-amber-300"
      data-testid="editing-indicator"
      title={emails.join(", ")}
    >
      <Pencil className="h-3 w-3" />
      {label}
    </span>
  );
}
