import { Loader2 } from "lucide-react";
export default function DepartmentLoading() {
  return <div role="status" className="flex min-h-64 items-center justify-center gap-2 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />Открываем отдел…</div>;
}
