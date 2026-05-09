import { Link } from "wouter";
import { Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useGetMe } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";

export function AdminLink() {
  const { data: user } = useGetMe();
  const { t } = useTranslation();
  if (!user || !user.isAdmin) return null;
  return (
    <Link href="/admin/users">
      <Button
        variant="ghost"
        size="sm"
        className="text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground h-8"
        data-testid="link-admin"
      >
        <Users className="h-4 w-4 mr-2" />
        {t("common.admin")}
      </Button>
    </Link>
  );
}
