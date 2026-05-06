import { Link } from "wouter";
import { Users } from "lucide-react";
import { useGetMe } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";

export function AdminLink() {
  const { data: user } = useGetMe();
  if (!user || !user.isAdmin) return null;
  return (
    <Link href="/admin/users">
      <Button
        variant="ghost"
        size="sm"
        className="text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground h-8"
      >
        <Users className="h-4 w-4 mr-2" />
        Admin
      </Button>
    </Link>
  );
}
