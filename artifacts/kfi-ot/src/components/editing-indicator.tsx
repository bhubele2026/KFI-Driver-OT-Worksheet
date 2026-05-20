import { Pencil } from "lucide-react";
import { useTranslation } from "react-i18next";

interface Props {
  emails: string[];
}

export function EditingIndicator({ emails }: Props) {
  const { t } = useTranslation();
  if (emails.length === 0) return null;
  const label =
    emails.length === 1
      ? t("editingIndicator.singular", { email: emails[0] })
      : t("editingIndicator.plural", { count: emails.length });
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
