import { Loader2 } from "lucide-react";

/**
 * Route-level fallback for dashboard segments. It gives immediate feedback
 * while a server component resolves, instead of leaving the previous screen
 * frozen with no indication that navigation started.
 */
export default function DashboardLoading() {
  return (
    <div
      className="flex h-full min-h-40 items-center justify-center p-6"
      role="status"
      aria-live="polite"
    >
      <Loader2 className="mr-2 h-5 w-5 animate-spin text-muted-foreground" aria-hidden="true" />
      <span className="text-sm text-muted-foreground">Загрузка…</span>
    </div>
  );
}
