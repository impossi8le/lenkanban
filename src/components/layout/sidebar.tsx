"use client";

import { DepartmentNavigation } from "./DepartmentNavigation";
import { displayLogin } from "@/lib/login-identity";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  Home,
  Calendar,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Plus,
  FolderKanban,
  Send,
  Reply,
  CheckSquare,
  Users,
  Briefcase,
  Activity,
  Building2,
  Users2,
  UserCheck,
  Link2,
  UserPlus,
  ShieldCheck,
  Settings,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { apiFetch } from "@/lib/api";
import { useSession } from "next-auth/react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { ThemeToggle } from "@/components/shared/theme-toggle";
import { useState } from "react";
import { GlobalCreateRequest } from "@/components/dashboard/GlobalCreateRequest";

interface SidebarProps {
  isCollapsed?: boolean;
  onToggle?: () => void;
}

type AdminLink = {
  href: string;
  label: string;
  icon: React.ElementType;
};

const adminMainLinks: AdminLink[] = [
  { href: "/admin/users", label: "Пользователи", icon: Users },
  { href: "/admin/projects", label: "Проекты", icon: Briefcase },
  { href: "/admin/telemetry", label: "Телеметрия", icon: Activity },
];

const adminOrgLinks: AdminLink[] = [
  { href: "/admin/organization", label: "Подразделения", icon: Building2 },
  { href: "/admin/organization/groups", label: "Группы", icon: Users2 },
  { href: "/admin/organization/assignments", label: "Назначения", icon: UserCheck },
  { href: "/admin/organization/bindings", label: "Привязки досок", icon: Link2 },
  { href: "/admin/organization/applicants", label: "Круг заявителей", icon: UserPlus },
  { href: "/admin/organization/privileges", label: "Профили прав", icon: ShieldCheck },
  { href: "/admin/organization/role-assignments", label: "Роли групп и людей", icon: ShieldCheck },
];

export function Sidebar({ isCollapsed = false, onToggle }: SidebarProps) {
  const pathname = usePathname() ?? "";
  const scope = useSearchParams()?.get("scope") ?? "mine";
  const { data: session } = useSession();
  const adminQuery = useQuery({
    queryKey: ["adminMe", session?.user?.id],
    enabled: Boolean(session?.user?.id),
    queryFn: async () => {
      try {
        return await apiFetch<{ globalRole: "USER" | "ADMIN" }>("/api/admin/me");
      } catch {
        return null;
      }
    },
    retry: false,
  });

  const isAdmin = adminQuery.data?.globalRole === "ADMIN";
  const adminOrgActive = adminOrgLinks.some((link) =>
    pathname.startsWith(link.href),
  );
  const [orgOpen, setOrgOpen] = useState(adminOrgActive);

  const user = session?.user as { name?: string | null; email?: string | null } | undefined;

  const navLinkClass = (active: boolean) =>
    cn(
      "flex items-center gap-3 rounded-lg px-3 py-2 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
      active
        ? "workspace-sidebar-active bg-accent text-accent-foreground font-medium"
        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
    );

  return (
    <div
      className={cn(
        "workspace-sidebar flex h-full min-h-0 w-full flex-col overflow-hidden text-card-foreground border-r [&_nav_a]:min-h-11",
        isCollapsed
          ? "min-w-[60px] [&_nav]:px-2 [&_nav_a]:justify-center [&_nav_a]:px-0"
          : "min-w-0",
      )}
    >
      {/* Header */}
      <div className="flex min-h-14 shrink-0 items-center justify-between px-2 border-b">
        {!isCollapsed && (
          <span className="workspace-brand flex items-center gap-2.5 font-semibold tracking-tight">
            <FolderKanban className="h-5 w-5 text-primary" aria-hidden="true" />
            Ленканбан
          </span>
        )}
        {onToggle && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onToggle}
            className="workspace-sidebar-toggle shrink-0"
            aria-label={isCollapsed ? "Развернуть боковую панель" : "Свернуть боковую панель"}
            aria-expanded={!isCollapsed}
          >
            {isCollapsed ? (
              <ChevronRight className="h-4 w-4" />
            ) : (
              <ChevronLeft className="h-4 w-4" />
            )}
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-4">
        <div className="px-3 pb-4"><GlobalCreateRequest collapsed={isCollapsed} /></div>
        {/* Navigation */}
        {!isCollapsed && (
          <div className="px-4 py-2">
            <div className="workspace-sidebar-heading text-xs font-semibold text-muted-foreground mb-2">
              Рабочее пространство
            </div>
          </div>
        )}

        <nav aria-label="Основная навигация" className="grid gap-1 px-3">
          <Link
            href="/"
            className={navLinkClass(pathname === "/")}
            title={isCollapsed ? "Главная" : undefined}
          >
            <Home className="h-4 w-4 flex-shrink-0" />
            {!isCollapsed && <span>Главная</span>}
          </Link>

          <Link
            href="/my-day"
            className={navLinkClass(pathname === "/my-day")}
            aria-current={pathname === "/my-day" ? "page" : undefined}
            title={isCollapsed ? "Мой день" : undefined}
            aria-label={isCollapsed ? "Мой день" : undefined}
          >
            <Calendar className="h-4 w-4 flex-shrink-0" />
            {!isCollapsed && <span>Мой день</span>}
          </Link>

          {!isCollapsed && <div className="workspace-sidebar-heading px-3 pb-1 pt-3 text-xs font-semibold text-muted-foreground">Мои обращения</div>}
          {[
            { scope: "mine", label: "Мои отправленные обращения", Icon: Send },
            { scope: "assigned", label: "Я исполнитель", Icon: CheckSquare },
            { scope: "reply", label: "Мне нужно ответить", Icon: Reply },
          ].map(item => <Link key={item.scope} href={`/my-tasks?scope=${item.scope}`} className={navLinkClass(pathname === "/my-tasks" && scope === item.scope)} aria-current={pathname === "/my-tasks" && scope === item.scope ? "page" : undefined} title={isCollapsed ? item.label : undefined} aria-label={isCollapsed ? item.label : undefined}><item.Icon className="h-4 w-4 shrink-0" />{!isCollapsed && <span>{item.label}</span>}</Link>)}

          <Link
            href="/projects"
            className={navLinkClass(pathname === "/projects")}
            title={isCollapsed ? "Запросы в отделы" : undefined}
          >
            <FolderKanban className="h-4 w-4 flex-shrink-0" />
            {!isCollapsed && <span>Запросы в отделы</span>}
          </Link>

          {isAdmin && (
            <>
              {!isCollapsed && (
                <div className="px-4 py-2 mt-2">
                  <div className="workspace-sidebar-heading text-xs font-semibold text-muted-foreground">
                    Управление
                  </div>
                </div>
              )}

              {adminMainLinks.map((link) => {
                const Icon = link.icon;
                const active = pathname === link.href;
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    aria-current={active ? "page" : undefined}
                    title={isCollapsed ? link.label : undefined}
                    className={navLinkClass(active)}
                  >
                    <Icon className="h-4 w-4 flex-shrink-0" />
                    {!isCollapsed && <span>{link.label}</span>}
                  </Link>
                );
              })}

              {isCollapsed ? (
                adminOrgLinks.map((link) => {
                  const Icon = link.icon;
                  const active = pathname === link.href;
                  return (
                    <Link
                      key={link.href}
                      href={link.href}
                      aria-current={active ? "page" : undefined}
                      title={link.label}
                      className={navLinkClass(active)}
                    >
                      <Icon className="h-4 w-4 flex-shrink-0" />
                    </Link>
                  );
                })
              ) : (
                <div className="px-3">
                  <button
                    type="button"
                    onClick={() => setOrgOpen((prev) => !prev)}
                    aria-expanded={orgOpen}
                    className={cn(
                      "flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                      adminOrgActive
                        ? "bg-accent/50 text-accent-foreground font-medium"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                    )}
                  >
                    <Building2 className="h-4 w-4 flex-shrink-0" />
                    <span className="flex-1 text-left">Организация</span>
                    <ChevronDown
                      className={cn(
                        "h-4 w-4 flex-shrink-0 transition-transform",
                        !orgOpen && "-rotate-90",
                      )}
                    />
                  </button>
                  {orgOpen && (
                    <div className="mt-1 ml-4 flex flex-col gap-1 border-l pl-2">
                      {adminOrgLinks.map((link) => {
                        const Icon = link.icon;
                        const active = pathname === link.href;
                        return (
                          <Link
                            key={link.href}
                            href={link.href}
                            aria-current={active ? "page" : undefined}
                            className={cn(
                              navLinkClass(active),
                              "py-1.5",
                            )}
                          >
                            <Icon className="h-4 w-4 flex-shrink-0" />
                            <span>{link.label}</span>
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </nav>

        {/* Projects */}
        {(
          <>
            <Separator className="my-4" />
            {!isCollapsed && <div className="px-4 py-2">
              <div className="flex items-center justify-between mb-2">
                <div className="workspace-sidebar-heading text-xs font-semibold text-muted-foreground leading-none">
                  Запросы в отделы
                </div>
                {isAdmin && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="workspace-sidebar-toggle shrink-0 flex items-center justify-center focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                    asChild
                    aria-label="Добавить направление"
                  >
                    <Link href="/projects" className="flex items-center justify-center">
                      <Plus className="h-4 w-4" />
                    </Link>
                  </Button>
                )}
              </div>
            </div>}

            <DepartmentNavigation pathname={pathname} isCollapsed={isCollapsed} />
          </>
        )}
      </div>

      {/* Footer */}
      <footer aria-label="Настройки и профиль" className="mt-auto shrink-0 border-t pb-[env(safe-area-inset-bottom)]">
        {isAdmin && (
          <nav aria-label="Настройки" className="px-3 py-2">
            <Link href="/settings" aria-current={pathname === "/settings" ? "page" : undefined} title={isCollapsed ? "Настройки" : undefined} className={navLinkClass(pathname === "/settings")}>
              <Settings className="h-4 w-4 shrink-0" />
              {!isCollapsed && <span>Настройки</span>}
            </Link>
          </nav>
        )}
        {!isCollapsed && (
          <div className="px-4 py-3 border-t">
            <div className="flex items-center gap-3">
              <Avatar className="h-8 w-8 flex-shrink-0">
                <AvatarFallback className="workspace-sidebar-avatar text-xs">
                  {(user?.name?.[0] ?? user?.email?.[0] ?? "U").toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <div className="workspace-sidebar-user text-sm font-medium truncate leading-none">
                  {user?.name ?? (displayLogin(user?.email) || "User")}
                </div>
              </div>
              <div className="flex-shrink-0 flex items-center">
                <ThemeToggle />
              </div>
            </div>
          </div>
        )}

        {isCollapsed && (
          <div className="p-2 border-t flex justify-center">
            <ThemeToggle />
          </div>
        )}
      </footer>
    </div>
  );
}
