"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";
import { useQuery } from "@tanstack/react-query";
import { Flame, Wrench, Landmark } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { REQUEST_DEPARTMENTS, classifyDirectionName, departmentHref } from "@/lib/request-directions";
import { useNotificationSummary } from "@/hooks/useNotificationSummary";
import { cn } from "@/lib/utils";

type Binding = { id: string; name: string };

export function DepartmentNavigation({ pathname, isCollapsed = false, onNavigate }: {
  pathname: string; isCollapsed?: boolean; onNavigate?: () => void;
}) {
  const { data: session, status } = useSession();
  const actorId = status === "authenticated" ? session?.user?.id : undefined;
  const { data } = useQuery({
    queryKey: ["projects", "navigation", actorId],
    enabled: Boolean(actorId),
    queryFn: ({ signal }) => apiFetch<Binding[]>("/api/projects?view=navigation", { signal }),
  });
  const { byProject, isError } = useNotificationSummary();
  // A public label is not evidence of access. Protected bindings never cross actors.
  const bindings = actorId ? data : undefined;
  return <nav aria-label="Запросы в отделы" className="grid gap-1 px-3">{REQUEST_DEPARTMENTS.map(department => {
    const matches = bindings?.filter(board => classifyDirectionName(board.name) === department.kind) ?? [];
    const active = pathname === departmentHref(department.kind) || matches.some(board => pathname.startsWith(`/projects/${board.id}/`));
    const unread = matches.reduce((sum, board) => sum + (byProject?.[board.id] ?? 0), 0);
    const Icon = department.kind === "beznal" ? Landmark : department.kind === "support" ? Wrench : Flame;
    return <Link key={department.kind} href={departmentHref(department.kind)} prefetch={false}
      title={unread > 0 ? `${department.name}: непрочитанных уведомлений — ${unread}` : department.name} aria-label={isCollapsed ? `${department.name}${unread > 0 ? `: непрочитанных уведомлений — ${unread}` : ""}` : undefined} aria-current={active ? "page" : undefined} onClick={onNavigate}
      className={cn("relative flex min-h-11 min-w-0 items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        active ? "workspace-sidebar-active bg-accent text-accent-foreground font-medium" : "text-muted-foreground hover:bg-accent hover:text-accent-foreground")}>
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      {!isCollapsed && <span className="min-w-0 flex-1 break-words leading-snug">{department.name}</span>}
      {(unread > 0 || isError && matches.length > 0) && <span aria-label={isError ? "Счётчик уведомлений временно недоступен" : `Непрочитанных уведомлений: ${unread}`} title={isError ? "Не удалось обновить счётчик. Повторная проверка — при возвращении в окно." : undefined} className={cn("workspace-sidebar-badge flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-xs text-primary-foreground", isCollapsed && "absolute right-0 top-0")}>{isError ? "?" : unread}</span>}
    </Link>;
  })}</nav>;
}
