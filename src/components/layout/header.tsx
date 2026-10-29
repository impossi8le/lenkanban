"use client";

import { displayLogin } from "@/lib/login-identity";

import { Suspense } from "react";
import { LogOut } from "lucide-react";
import { signOut, useSession } from "next-auth/react";

import { ThemeToggle } from "@/components/shared/theme-toggle";
import { CommandPalette } from "@/components/layout/command-palette";
import { MobileSidebar } from "@/components/layout/mobile-sidebar";
import { ReportProblemButton } from "@/components/diagnostics/ReportProblemButton";
import { NotificationBell } from "@/components/layout/notification-bell";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

export function Header() {
  const { data } = useSession();

  const email = displayLogin(data?.user?.email) || null;
  const name = data?.user?.name ?? null;
  const initials = (name ?? email ?? "U")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");

  return (
    <header aria-label="Верхняя панель" className="flex min-h-14 shrink-0 items-center gap-1 border-b bg-card px-2 pt-[env(safe-area-inset-top)] sm:gap-3 sm:px-4 lg:px-6">
      <MobileSidebar />
      <div className="min-w-0 flex-1">
        <Suspense fallback={null}>
          <CommandPalette />
        </Suspense>
      </div>
      <div className="flex shrink-0 items-center gap-1 sm:gap-2">
        <ThemeToggle />
        <NotificationBell />
        <ReportProblemButton />

        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border bg-background hover:bg-accent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Открыть меню пользователя"
            >
              <Avatar className="h-8 w-8">
                <AvatarFallback className="text-xs font-semibold">{initials}</AvatarFallback>
              </Avatar>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56 max-w-[calc(100vw-1rem)]">
            <DropdownMenuLabel className="space-y-0.5">
              <div className="break-words text-sm font-medium leading-snug">{name ?? "Пользователь"}</div>
              {email ? <div className="break-all text-xs text-muted-foreground">{email}</div> : null}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => signOut({ callbackUrl: "/sign-in" })}
              className="cursor-pointer"
            >
              <LogOut className="mr-2 h-4 w-4" />
              Выйти
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
