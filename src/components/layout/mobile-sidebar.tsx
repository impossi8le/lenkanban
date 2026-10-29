"use client";

import * as React from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  Send,
  Reply,
  CheckSquare,
  LayoutDashboard,
  Calendar,
  Menu,
  X,
  FolderKanban,
  Users,
  Briefcase,
  Activity,
  Building2,
  Users2,
  UserCheck,
  Link2,
  UserPlus,
  ShieldCheck,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import { GlobalCreateRequest } from "@/components/dashboard/GlobalCreateRequest";
import { DepartmentNavigation } from "./DepartmentNavigation";

const navigation = [
  { href: "/", icon: LayoutDashboard, label: "Главная" },
  { href: "/my-day", icon: Calendar, label: "Мой день" },
  { href: "/my-tasks?scope=mine", icon: Send, label: "Мои отправленные обращения" },
  { href: "/my-tasks?scope=assigned", icon: CheckSquare, label: "Я исполнитель" },
  { href: "/my-tasks?scope=reply", icon: Reply, label: "Мне нужно ответить" },
  { href: "/projects", icon: FolderKanban, label: "Запросы в отделы" },
];

type AdminMe = {
  id: string;
  email: string;
  name: string | null;
  globalRole: "USER" | "ADMIN";
};

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

function mobileNavClass(active: boolean) {
  return cn(
    "flex items-center gap-3 rounded-lg px-3 py-2.5 transition-all",
    active
      ? "bg-primary/10 text-primary font-medium"
      : "text-muted-foreground hover:bg-accent hover:text-foreground",
  );
}

export function MobileSidebar() {
  const [open, setOpen] = React.useState(false);
  const desktopMedia = React.useRef<MediaQueryList | null>(null);
  const pathname = usePathname() ?? "";
  const scope = useSearchParams()?.get("scope") ?? "mine";

  React.useEffect(() => {
    const desktop = window.matchMedia("(min-width: 768px)");
    desktopMedia.current = desktop;
    const closeOnDesktop = () => {
      if (desktop.matches) setOpen(false);
    };
    closeOnDesktop();
    desktop.addEventListener("change", closeOnDesktop);
    return () => {
      desktop.removeEventListener("change", closeOnDesktop);
      desktopMedia.current = null;
    };
  }, []);

  const { data: session } = useSession();
  const adminQuery = useQuery({
    queryKey: ["adminMe", session?.user?.id],
    enabled: Boolean(session?.user?.id),
    queryFn: async () => {
      try {
        return await apiFetch<AdminMe>("/api/admin/me");
      } catch {
        // 404 means user is not an admin - this is expected, not an error
        return null;
      }
    },
    retry: false,
  });

  const isAdmin = adminQuery.data?.globalRole === "ADMIN";

  return (
    <Drawer open={open} onOpenChange={setOpen} autoFocus>
      <DrawerTrigger asChild>
        <Button variant="ghost" size="icon" className="shrink-0 md:hidden">
          <Menu className="h-5 w-5" />
          <span className="sr-only">Переключить меню</span>
        </Button>
      </DrawerTrigger>
      <DrawerContent
        className="workspace-sidebar h-[85dvh] max-h-[calc(100dvh-env(safe-area-inset-top)-1rem)] overflow-clip pb-[env(safe-area-inset-bottom)]"
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          if (desktopMedia.current?.matches) {
            event.preventDefault();
            document
              .querySelector<HTMLButtonElement>("[data-command-palette]")
              ?.focus();
          }
        }}
      >
        <DrawerHeader className="shrink-0">
          <DrawerTitle className="flex items-center justify-between">
            ЛЕНКАНБАН
            <Button
              variant="ghost"
              size="icon"
              aria-label="Закрыть меню"
              onClick={() => setOpen(false)}
            >
              <X className="h-4 w-4" />
            </Button>
          </DrawerTitle>
        </DrawerHeader>
        <div
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          data-vaul-no-drag
        >
          <div className="px-4 pt-4"><GlobalCreateRequest /></div>
          <nav
            aria-label="Основная навигация"
            className="flex flex-col gap-1 p-4 [&_a]:min-h-11 [&_svg]:shrink-0"
          >
            {navigation.filter(item => item.href !== "/analytics" || isAdmin).map((item) => {
              const isActive = item.href.startsWith("/my-tasks?") ? pathname === "/my-tasks" && item.href === `/my-tasks?scope=${scope}` : pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={isActive ? "page" : undefined}
                  onClick={() => setOpen(false)}
                  className={mobileNavClass(isActive)}
                >
                  <item.icon className="h-5 w-5" />
                  <span>{item.label}</span>
                </Link>
              );
            })}

            {isAdmin && (
              <>
                <div className="workspace-sidebar-heading mt-3 mb-1 px-3 text-xs font-semibold text-muted-foreground">
                  АДМИНИСТРИРОВАНИЕ
                </div>
                {adminMainLinks.map((link) => {
                  const Icon = link.icon;
                  const isActive = pathname === link.href;
                  return (
                    <Link
                      key={link.href}
                      href={link.href}
                      aria-current={isActive ? "page" : undefined}
                      onClick={() => setOpen(false)}
                      className={mobileNavClass(isActive)}
                    >
                      <Icon className="h-5 w-5" />
                      <span>{link.label}</span>
                    </Link>
                  );
                })}

                <div className="workspace-sidebar-heading mt-2 mb-1 px-3 text-xs font-semibold text-muted-foreground">
                  ОРГАНИЗАЦИЯ
                </div>
                {adminOrgLinks.map((link) => {
                  const Icon = link.icon;
                  const isActive = pathname === link.href;
                  return (
                    <Link
                      key={link.href}
                      href={link.href}
                      aria-current={isActive ? "page" : undefined}
                      onClick={() => setOpen(false)}
                      className={mobileNavClass(isActive)}
                    >
                      <Icon className="h-5 w-5" />
                      <span>{link.label}</span>
                    </Link>
                  );
                })}
              </>
            )}
          </nav>

          {/* Projects Section */}
          <div className="border-t my-2"></div>
          <div className="px-4">
            <h3 className="workspace-sidebar-heading text-xs font-semibold text-muted-foreground mb-2">
              ЗАПРОСЫ В ОТДЕЛЫ
            </h3>
          </div>
          <DepartmentNavigation pathname={pathname} onNavigate={() => setOpen(false)} />
        </div>
      </DrawerContent>
    </Drawer>
  );
}

