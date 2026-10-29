"use client";
import {SearchHighlight} from "@/components/ui/SearchHighlight";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Trash2, X } from "lucide-react";

import { apiFetch, apiPatch, apiPost } from "@/lib/api";
import { displayLogin } from "@/lib/login-identity";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

type ProjectRole = "MEMBER" | "PROJECT_ADMIN";

type ApiUser = {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  globalRole?: "USER" | "ADMIN";
  primaryDepartment?: { id: string; name: string; archivedAt: string | null } | null;
};

type ApiMember = {
  id: string;
  role: ProjectRole;
  createdAt: string;
  user: ApiUser;
  addedBy?: { id: string; email: string; name: string | null } | null;
};

type MembersResponse = {
  projectId: string;
  ownerId: string | null;
  owner: ApiUser | null;
  items: ApiMember[];
  responsibleGroup?: { id: string; name: string; memberUserIds: string[] } | null;
  memberFunctions?: MemberFunction[];
  functionContext?: {
    applicantPolicyConfigured: boolean;
    departmentLeadershipAssigned: boolean | null;
    groupLeadershipAssigned: boolean | null;
  };
};

type MemberFunction = {
  userId: string;
  leadership: { kind: "department" | "group"; id: string; name: string }[];
  applicant: {
    allowed: boolean | null;
    source: "unconfigured" | "all_employees" | "explicit_user" | "primary_department" | "responsible_group" | "not_in_policy" | "unavailable";
  };
};

function MemberFunctionBadges({ facts }: { facts: MemberFunction | undefined }) {
  const sources = { all_employees: "все сотрудники", explicit_user: "назначен явно", primary_department: "подразделение", responsible_group: "группа" };
  const source = facts?.applicant.source;
  const applicantLabel = facts?.applicant.allowed === true && source && source in sources
    ? `Заявитель: ${sources[source as keyof typeof sources]}`
    : facts?.applicant.allowed === false ? "Не входит в круг заявителей"
      : source === "unconfigured" ? "Круг заявителей не настроен" : "Функция заявителя не подтверждена";
  return <>
    {facts?.leadership.map(scope => <Badge key={`${scope.kind}:${scope.id}`} variant="secondary">
      {scope.kind === "department" ? "Руководитель подразделения" : "Руководитель группы"}: {scope.name}
    </Badge>)}
    <Badge variant="outline">{applicantLabel}</Badge>
  </>;
}

function displayName(user: ApiUser) {
  return user.name?.trim() || displayLogin(user.email);
}

function focusReturnTarget(element: Element | null): HTMLElement | null {
  if (!(element instanceof HTMLElement) || element === document.body) return null;
  const triggerId = element.closest('[role="menu"]')?.getAttribute("aria-labelledby");
  const menuTrigger = triggerId ? document.getElementById(triggerId) : null;
  return menuTrigger instanceof HTMLButtonElement && menuTrigger.isConnected
    ? menuTrigger
    : element;
}

export function ProjectMembersDialog({
  projectId,
  canManage,
  open,
  onOpenChange,
}: {
  projectId: string;
  canManage: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [internalOpen, setInternalOpen] = React.useState(false);
  const isOpen = open !== undefined ? open : internalOpen;
  const setIsOpen = onOpenChange || setInternalOpen;
  const [selectedUserId, setSelectedUserId] = React.useState("");
  const [searchQuery, setSearchQuery] = React.useState("");
  const [showDropdown, setShowDropdown] = React.useState(false);
  const [newRole, setNewRole] = React.useState<ProjectRole>("MEMBER");
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const openerRef = React.useRef<HTMLElement | null>(null);
  const firstUserOptionRef = React.useRef<HTMLButtonElement>(null);
  const focusResultsOnOpenRef = React.useRef(false);
  const rememberOpener = React.useCallback((node: HTMLDivElement | null) => {
    if (node && !openerRef.current?.isConnected) {
      openerRef.current = focusReturnTarget(document.activeElement);
    }
  }, []);

  const membersQuery = useQuery({
    queryKey: ["projectMembers", projectId],
    queryFn: () => apiFetch<MembersResponse>(`/api/projects/${projectId}/members`),
    enabled: isOpen && canManage,
    retry: false,
  });

  // Fetch all users for the dropdown - enabled when dialog is open
  const usersQuery = useQuery({
    queryKey: ["users", searchQuery],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (searchQuery.trim()) {
        params.append('q', searchQuery.trim());
      }
      params.append('take', '50');
      const result = await apiFetch<ApiUser[]>(`/api/users?${params.toString()}`);
      return result;
    },
    enabled: isOpen && canManage,
    retry: false,
  });

  React.useEffect(() => {
    if (showDropdown && focusResultsOnOpenRef.current && firstUserOptionRef.current) {
      focusResultsOnOpenRef.current = false;
      firstUserOptionRef.current.focus();
    }
  }, [showDropdown, usersQuery.data]);

  // Reset state when dialog closes
  React.useEffect(() => {
    if (!isOpen) {
      setSelectedUserId("");
      setSearchQuery("");
      setShowDropdown(false);
    }
  }, [isOpen]);

  const addMutation = useMutation({
    mutationFn: async (payload: { userId: string; role?: ProjectRole }) => {
      // Get user email from selected user
      const users = await apiFetch<ApiUser[]>(`/api/users?take=100`);
      const user = users.find(u => u.id === payload.userId);
      if (!user) throw new Error("User not found");

      return apiPost<ApiMember>(`/api/projects/${projectId}/members`, {
        email: user.email,
        role: payload.role,
      });
    },
    onSuccess: async () => {
      setSelectedUserId("");
      setSearchQuery("");
      setShowDropdown(false);
      setNewRole("MEMBER");
      await queryClient.invalidateQueries({ queryKey: ["projectMembers", projectId] });
      // Close dialog if it's controlled
      if (onOpenChange) {
        setIsOpen(false);
      }
      toast.success("Участник добавлен");
    },
    onError: (e: unknown) => {
      const err = e as { status?: number; payload?: { code?: string } };
      const code = err?.payload?.code;
      const message =
        err?.status === 404
          ? "Пользователь не найден (должен быть зарегистрирован)"
          : code
            ? code
            : e instanceof Error
              ? e.message
              : "Попробуйте еще раз";

      toast.error("Не удалось добавить участника", { description: message });
    },
  });

  const patchRoleMutation = useMutation({
    mutationFn: ({ memberId, role }: { memberId: string; role: ProjectRole }) =>
      apiPatch<ApiMember>(`/api/projects/${projectId}/members/${memberId}`, { role }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["projectMembers", projectId] });
    },
    onError: (e: unknown) => {
      const err = e as { status?: number; payload?: { code?: string } };
      const message =
        err?.status === 409
          ? err?.payload?.code || "Конфликт"
          : err?.payload?.code || (e instanceof Error ? e.message : "Попробуйте еще раз");

      toast.error("Не удалось изменить роль", { description: message });
    },
  });

  const removeMutation = useMutation({
    mutationFn: async ({ memberId }: { memberId: string }) => {
      // apiDelete expects JSON; here API returns 204, so use fetch directly
      const res = await fetch(`/api/projects/${projectId}/members/${memberId}`, { method: "DELETE" });
      if (!res.ok) {
        const payload = await res.json().catch(() => null) as { message?: string; code?: string } | null;
        throw Object.assign(new Error(payload?.message || "Request failed"), { status: res.status, payload });
      }
      return true;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["projectMembers", projectId] });
      toast.success("Участник удален");
    },
    onError: (e: unknown) => {
      const err = e as { status?: number; payload?: { code?: string } };
      const message =
        err?.status === 409
          ? err?.payload?.code || "Конфликт"
          : err?.payload?.code || (e instanceof Error ? e.message : "Попробуйте еще раз");

      toast.error("Не удалось удалить участника", { description: message });
    },
  });

  const data = membersQuery.data;
  const owner = data?.owner;
  const items = data?.items ?? [];

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogContent
        ref={rememberOpener}
        className="min-w-0 max-w-2xl max-h-[calc(100dvh-2rem)] overflow-y-auto p-4 [overflow-wrap:anywhere] sm:p-6"
        onOpenAutoFocus={() => {
          if (!openerRef.current?.isConnected) {
            openerRef.current = focusReturnTarget(document.activeElement);
          }
        }}
        onCloseAutoFocus={(event) => {
          const opener = openerRef.current;
          openerRef.current = null;
          focusResultsOnOpenRef.current = false;
          if (opener?.isConnected && opener !== document.body) {
            event.preventDefault();
            opener.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Участники проекта</DialogTitle>
          <DialogDescription>
            Управление доступом к проекту. Роль на доске и ответственная группа показываются отдельно.
          </DialogDescription>
        </DialogHeader>

        {!canManage ? (
          <div className="text-sm text-muted-foreground">У вас нет доступа.</div>
        ) : membersQuery.isLoading ? (
          <div role="status" className="space-y-3">
            <span className="sr-only">Загрузка участников…</span>
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : membersQuery.isError ? (
          <div role="alert" className="text-sm text-destructive">
            Не удалось загрузить участников.
          </div>
        ) : (
          <div className="space-y-5">
            <p className="text-sm text-muted-foreground">
              {data?.responsibleGroup ? `Ответственная группа: ${data.responsibleGroup.name}.` : "Ответственная группа не настроена."}
              {" "}Наблюдатели назначаются в каждой заявке; участие в доске само по себе не означает роль наблюдателя или исполнителя.
            </p>
            <p className="text-sm text-muted-foreground">
              {data?.functionContext ? <>
                Руководство подразделения: {data.functionContext.departmentLeadershipAssigned === null ? "подразделение не настроено" : data.functionContext.departmentLeadershipAssigned ? "назначено" : "не назначено"}.
                {" "}Руководство группы: {data.functionContext.groupLeadershipAssigned === null ? "группа не настроена" : data.functionContext.groupLeadershipAssigned ? "назначено" : "не назначено"}.
                {" "}{data.functionContext.applicantPolicyConfigured ? "Круг заявителей задан политикой доски." : "Круг заявителей не настроен; доступ к созданию проверяется сервером."}
              </> : "Фактические функции сотрудников не подтверждены."}
              {" "}Эти сведения не изменяют права доступа; наблюдение проверяется в самой заявке.
            </p>
            <div className="space-y-2">
               <Label htmlFor="member-search">Выбрать пользователя</Label>
               <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap">
                 <Popover open={showDropdown} onOpenChange={setShowDropdown}>
                   <PopoverTrigger asChild>
                     <div className="relative min-w-0 flex-1">
                       <Input
                         ref={searchInputRef}
                         id="member-search"
                         placeholder="Нажмите для списка или введите имя/email..."
                         value={searchQuery}
                         onChange={(e) => {
                           focusResultsOnOpenRef.current = false;
                           setSearchQuery(e.target.value);
                         }}
                         onKeyDown={(event) => {
                           if (event.key === "Enter" || event.key === "ArrowDown") {
                             event.preventDefault();
                             focusResultsOnOpenRef.current = true;
                             setShowDropdown(true);
                             if (firstUserOptionRef.current) {
                               focusResultsOnOpenRef.current = false;
                               firstUserOptionRef.current.focus();
                             }
                           }
                         }}
                         className="cursor-pointer pr-11"
                       />
                       {selectedUserId && searchQuery && (
                         <button
                           type="button"
                           aria-label="Очистить выбор пользователя"
                           className="absolute right-1 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                           onClick={(e) => {
                             e.preventDefault();
                             e.stopPropagation();
                             focusResultsOnOpenRef.current = false;
                             setSelectedUserId("");
                             setSearchQuery("");
                             searchInputRef.current?.focus();
                           }}
                         >
                           <X className="h-4 w-4" />
                         </button>
                       )}
                     </div>
                   </PopoverTrigger>
                    <PopoverContent
                      aria-label="Выбор пользователя"
                      className="w-[var(--radix-popover-trigger-width)] min-w-0 max-w-[calc(100vw-2rem)] p-0"
                      align="start"
                      collisionPadding={8}
                      onOpenAutoFocus={(event) => {
                        event.preventDefault();
                        if (focusResultsOnOpenRef.current && firstUserOptionRef.current) {
                          focusResultsOnOpenRef.current = false;
                          firstUserOptionRef.current.focus();
                        }
                      }}
                      onCloseAutoFocus={(event) => {
                        event.preventDefault();
                        focusResultsOnOpenRef.current = false;
                        searchInputRef.current?.focus();
                      }}
                    >
                      <div className="max-h-[min(15rem,calc(var(--radix-popover-content-available-height)_-_2px))] overflow-auto" onWheel={(e) => e.stopPropagation()}>
                       {usersQuery.isLoading ? (
                         <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                           Загрузка пользователей...
                         </div>
                       ) : usersQuery.data && usersQuery.data.length > 0 ? (
                          usersQuery.data.map((user, index) => {
                           return (
                             <button
                               type="button"
                               ref={index === 0 ? firstUserOptionRef : undefined}
                               key={user.id}
                               className="flex w-full min-w-0 flex-col gap-0.5 border-b px-3 py-2 text-left [overflow-wrap:anywhere] hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring last:border-b-0"
                               onClick={() => {
                                 setSelectedUserId(user.id);
                                 setSearchQuery(displayName(user));
                                 setShowDropdown(false);
                               }}
                             >
                               <span className="flex min-w-0 flex-wrap items-center gap-2">
                                 <span className="min-w-0 font-medium [overflow-wrap:anywhere]"><SearchHighlight text={displayName(user)} query={searchQuery}/></span>
                                 {user.globalRole === "ADMIN" && (
                                   <Badge variant="secondary" className="shrink-0 whitespace-nowrap text-xs">АДМИН</Badge>
                                 )}
                               </span>
                               <span className="min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]"><SearchHighlight text={user.email} query={searchQuery}/></span>
                             </button>
                           );
                         })
                       ) : (
                         <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                           Пользователи не найдены
                         </div>
                       )}
                     </div>
                   </PopoverContent>
                 </Popover>
                 <Select value={newRole} onValueChange={(v) => setNewRole(v as ProjectRole)}>
                   <SelectTrigger aria-label="Роль нового участника" className="min-w-0 sm:w-[170px]">
                     <SelectValue placeholder="Роль" />
                   </SelectTrigger>
                   <SelectContent>
                     <SelectItem value="MEMBER">Участник</SelectItem>
                     <SelectItem value="PROJECT_ADMIN">Администратор</SelectItem>
                   </SelectContent>
                 </Select>
                 <Button
                   onClick={() => addMutation.mutate({ userId: selectedUserId, role: newRole })}
                   disabled={!selectedUserId || addMutation.isPending}
                 >
                   <Plus className="h-4 w-4 mr-2" />
                   {addMutation.isPending ? "Добавление…" : "Добавить"}
                 </Button>
               </div>
               <div className="min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                 {selectedUserId
                   ? `Выбран: ${usersQuery.data?.find(u => u.id === selectedUserId)?.email || ""}`
                   : "Введите имя или email для поиска пользователя"
                 }
               </div>
            </div>

            <Separator />

            <div className="space-y-3">
              <div className="text-sm font-medium">Владелец</div>
              {owner ? (
                <div className="flex min-w-0 flex-col items-stretch justify-between gap-3 rounded-lg border p-3 sm:flex-row sm:items-center">
                  <div className="min-w-0 sm:flex-1">
                    <div className="font-medium [overflow-wrap:anywhere]">{displayName(owner)}</div>
                    <div className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{owner.email}</div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
                    <Badge variant="secondary" className="shrink-0 whitespace-nowrap">ВЛАДЕЛЕЦ</Badge>
                    {owner.globalRole === "ADMIN" ? <Badge className="shrink-0 whitespace-nowrap">АДМИН</Badge> : null}
                     {data?.responsibleGroup?.memberUserIds.includes(owner.id) ? <Badge variant="secondary">Ответственная группа: {data.responsibleGroup.name}</Badge> : null}
                     <MemberFunctionBadges facts={data?.memberFunctions?.find(fact => fact.userId === owner.id)} />
                  </div>
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">Неизвестно</div>
              )}

              <div className="text-sm font-medium mt-4">Участники</div>

              {items.length === 0 ? (
                <div className="text-sm text-muted-foreground">Участников пока нет.</div>
              ) : (
                <div className="space-y-2">
                  {items.map((m) => {
                    const isOwner = !!data?.ownerId && m.user.id === data.ownerId;
                     const addedBy = m.addedBy?.email ?? null;
                     const addedAt = m.createdAt ? new Date(m.createdAt) : null;

                     return (
                       <div key={m.id} className="flex min-w-0 flex-col items-stretch justify-between gap-3 rounded-lg border p-3 sm:flex-row sm:items-center">
                         <div className="min-w-0 sm:flex-1">
                           <div className="flex min-w-0 flex-wrap items-center gap-2">
                             <div className="min-w-0 font-medium [overflow-wrap:anywhere]">{displayName(m.user)}</div>
                             {m.user.globalRole === "ADMIN" ? <Badge className="shrink-0 whitespace-nowrap">АДМИН</Badge> : null}
                             {isOwner ? <Badge variant="secondary" className="shrink-0 whitespace-nowrap">ВЛАДЕЛЕЦ</Badge> : null}
                             {m.role === "PROJECT_ADMIN" ? <Badge variant="secondary">Управляющий доской</Badge> : null}
                             {data?.responsibleGroup?.memberUserIds.includes(m.user.id) ? <Badge variant="secondary">Ответственная группа: {data.responsibleGroup.name}</Badge> : null}
                             {m.user.primaryDepartment?.archivedAt === null ? <Badge variant="outline">Подразделение: {m.user.primaryDepartment.name}</Badge> : null}
                             <MemberFunctionBadges facts={data?.memberFunctions?.find(fact => fact.userId === m.user.id)} />
                           </div>
                           <div className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{displayLogin(m.user.email)}</div>
                           {addedBy || addedAt ? (
                             <div className="mt-1 text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
                               {addedBy ? `Добавил ${addedBy}` : ""}
                               {addedBy && addedAt ? " · " : ""}
                               {addedAt ? addedAt.toLocaleDateString('ru-RU') : ""}
                             </div>
                           ) : null}
                         </div>

                         <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto sm:shrink-0">
                           <Select
                             value={m.role}
                             onValueChange={(v) => patchRoleMutation.mutate({ memberId: m.id, role: v as ProjectRole })}
                             disabled={patchRoleMutation.isPending || isOwner}
                           >
                             <SelectTrigger aria-label={`Роль участника ${displayName(m.user)}`} className="min-w-0 flex-1 sm:w-[170px] sm:flex-none">
                               <SelectValue placeholder="Роль" />
                             </SelectTrigger>
                             <SelectContent>
                               <SelectItem value="MEMBER">Участник</SelectItem>
                               <SelectItem value="PROJECT_ADMIN">Администратор</SelectItem>
                             </SelectContent>
                           </Select>

                           <Button
                             variant="outline"
                             size="icon"
                             className="shrink-0"
                             onClick={() => {
                               const ok = window.confirm(`Удалить ${m.user.email} из проекта?`);
                               if (!ok) return;
                               removeMutation.mutate({ memberId: m.id });
                             }}
                             disabled={removeMutation.isPending || isOwner}
                             aria-label="Удалить участника"
                           >
                             <Trash2 className="h-4 w-4" />
                           </Button>
                         </div>
                       </div>
                     );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
