"use client";

import * as React from "react";
import { Bell, Check } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import { ru } from "date-fns/locale";
import { useNotificationSocket } from "@/hooks/useNotificationSocket";
import { useBrowserNotifications } from "@/hooks/useBrowserNotifications";
import { apiFetch } from "@/lib/api";
import { useSession } from "next-auth/react";
import { useNotificationSummary } from "@/hooks/useNotificationSummary";

interface Notification {
  id: string;
  type: string;
  title: string;
  message: string;
  read: boolean;
  readAt: string | null;
  actionUrl: string | null;
  metadata: unknown;
  createdAt: string;
  currentTask?: { taskId: string; projectId: string; phase: { code: string; label: string } } | null;
}

function isQueueEvent(notification: Notification): boolean {
  const metadata = notification.metadata;
  return !!metadata && typeof metadata === "object" && !Array.isArray(metadata)
    && "reason" in metadata && metadata.reason === "queue";
}

export function NotificationBell() {
  const { data: session, status } = useSession();
  const actorId = status === "authenticated" && typeof session?.user?.id === "string" && session.user.id.length > 0
    ? session.user.id : null;
  const [view, setView] = React.useState<{ actorId: string | null; generation: number; open: boolean }>({ actorId: null, generation: 0, open: false });
  const generation = view.actorId === actorId ? view.generation : view.generation + 1;
  const token = `${generation}:${actorId ?? ""}`;
  const liveTokenRef = React.useRef(token);
  liveTokenRef.current = token;
  if (view.actorId !== actorId) setView({ actorId, generation, open: false });
  const open = actorId !== null && view.actorId === actorId && view.open;
  const setOpen = (value: boolean) => {
    if (!actorId || liveTokenRef.current !== token) return;
    setView(current => current.actorId === actorId && current.generation === generation ? { ...current, open: value } : current);
  };
  const headingId = React.useId();
  const popoverId = React.useId();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { socket, connected } = useNotificationSocket();
  const browserNotifications = useBrowserNotifications();
  const previousActorRef = React.useRef(actorId);
  React.useEffect(() => {
    const previousActor = previousActorRef.current;
    previousActorRef.current = actorId;
    if (previousActor && previousActor !== actorId) {
      void queryClient.cancelQueries({ queryKey: ["notifications", previousActor] });
      queryClient.removeQueries({ queryKey: ["notifications", previousActor] });
    }
  }, [actorId, queryClient]);

  // Listen for real-time notifications
  React.useEffect(() => {
    if (!socket || !actorId) return;

    const handleNewNotification = () => {
      if (liveTokenRef.current !== token) return;
      void queryClient.invalidateQueries({ queryKey: ["notifications", actorId] });
    };

    socket.on("notification:new", handleNewNotification);
    socket.on("task:updated", handleNewNotification);
    socket.on("task:deleted", handleNewNotification);

    return () => {
      socket.off("notification:new", handleNewNotification);
      socket.off("task:updated", handleNewNotification);
      socket.off("task:deleted", handleNewNotification);
    };
  }, [socket, queryClient, actorId, token]);

  // Joining is the delivery boundary, including the first join: a notification
  // can commit after the initial count read but before room membership exists.
  React.useEffect(() => {
    if (connected && actorId) void queryClient.invalidateQueries({ queryKey: ["notifications", actorId] });
  }, [connected, actorId, queryClient]);

  React.useEffect(() => {
    if (!actorId) return;
    let lastRefresh = 0;
    let pending: ReturnType<typeof setTimeout> | undefined;
    const reconcile = () => {
      if (document.visibilityState !== "visible" || pending || Date.now() - lastRefresh < 5000) return;
      pending = setTimeout(() => {
        pending = undefined;
        if (document.visibilityState !== "visible" || liveTokenRef.current !== token) return;
        lastRefresh = Date.now();
        void queryClient.invalidateQueries({ queryKey: ["notifications", actorId] });
      }, 100);
    };
    document.addEventListener("visibilitychange", reconcile);
    window.addEventListener("focus", reconcile);
    return () => {
      clearTimeout(pending);
      document.removeEventListener("visibilitychange", reconcile);
      window.removeEventListener("focus", reconcile);
    };
  }, [actorId, queryClient, token]);

  const unreadSummary = useNotificationSummary({ poll: !connected });
  const unreadCount = actorId !== null ? unreadSummary.count : undefined;

  // Fetch notifications when popover opens
  const { data: notifications = [], isLoading, isError } = useQuery<Notification[]>({
    queryKey: ["notifications", actorId, "list"],
    queryFn: ({ signal }) => apiFetch<Notification[]>("/api/notifications?limit=20", { signal }),
    enabled: actorId !== null && open,
    refetchOnMount: "always",
    refetchInterval: open ? 15000 : false,
  });

  React.useEffect(() => {
    if (open && actorId) void queryClient.invalidateQueries({ queryKey: ["notifications", actorId, "list"] });
  }, [open, actorId, queryClient]);

  React.useEffect(() => {
    if (!actorId) return;
    const refresh = () => {
      if (liveTokenRef.current === token) void queryClient.invalidateQueries({ queryKey: ["notifications", actorId, "list"] });
    };
    window.addEventListener("beznal:attachment-committed", refresh);
    // Existing task readers reconcile after commands and realtime updates. Use
    // their successful refresh as an invalidation signal, never as task data.
    const taskQueries = new Set(["task", "tasks", "my-tasks", "my-task-details", "task-lifecycle"]);
    const unsubscribe = queryClient.getQueryCache().subscribe(event => {
      if (event.type === "updated" && event.action.type === "success"
        && typeof event.query.queryKey[0] === "string" && taskQueries.has(event.query.queryKey[0])) refresh();
    });
    return () => {
      window.removeEventListener("beznal:attachment-committed", refresh);
      unsubscribe();
    };
  }, [actorId, queryClient, token]);

  // Mark single notification as read
  const markReadMutation = useMutation({
    mutationFn: ({ notificationId, actorId: targetActor, token: targetToken }: { notificationId: string; actorId: string; token: string }) => {
      if (liveTokenRef.current !== targetToken || !targetActor) throw new Error("Сеанс изменился");
      return apiFetch(`/api/notifications/${encodeURIComponent(notificationId)}`, { method: "PATCH" });
    },
    onSuccess: (_result, variables) => {
      if (liveTokenRef.current !== variables.token) return;
      const listKey = ["notifications", variables.actorId, "list"];
      queryClient.setQueryData<Notification[]>(listKey, current => current?.map(item => item.id === variables.notificationId
        ? { ...item, read: true, readAt: new Date().toISOString() } : item));
      // Refetch all buckets together; decrementing only the bell splits it from boards.
      void queryClient.invalidateQueries({ queryKey: ["notifications", variables.actorId] });
    },
  });

  // Mark all as read
  const markAllReadMutation = useMutation({
    mutationFn: ({ actorId: targetActor, token: targetToken }: { actorId: string; token: string }) => {
      if (liveTokenRef.current !== targetToken || !targetActor) throw new Error("Сеанс изменился");
      return apiFetch("/api/notifications/mark-all-read", { method: "PATCH" });
    },
    onSuccess: (_result, variables) => {
      if (liveTokenRef.current === variables.token) void queryClient.invalidateQueries({ queryKey: ["notifications", variables.actorId] });
    },
  });

  const singleReadPending = markReadMutation.isPending && markReadMutation.variables?.token === token;
  const allReadPending = markAllReadMutation.isPending && markAllReadMutation.variables?.token === token;
  const handleMarkRead = (notification: Notification) => {
    if (!actorId || liveTokenRef.current !== token || notification.read || singleReadPending || allReadPending
      || !notifications.some(item => item.id === notification.id)) return;
    markReadMutation.mutate({ notificationId: notification.id, actorId, token });
  };

  const handleNotificationClick = (notification: Notification) => {
    if (!actorId || liveTokenRef.current !== token || !notifications.some(item => item.id === notification.id)) return;
    // A task notification is read only after its actual card loads. A failed
    // navigation must leave it unread; the explicit check button still works.
    const metadata = notification.metadata as { taskId?: unknown } | null;
    const taskTarget = metadata && typeof metadata === "object" && typeof metadata.taskId === "string";
    if (!notification.read && !taskTarget) {
      handleMarkRead(notification);
    }

    // Navigate to action URL
    if (notification.actionUrl) {
      router.push(notification.actionUrl);
      setOpen(false);
    }
  };

  const handleMarkAllRead = () => {
    if (!actorId || liveTokenRef.current !== token) return;
    markAllReadMutation.mutate({ actorId, token });
  };

  return (
    <Popover key={token} open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative h-11 w-11 shrink-0"
          aria-label="Уведомления"
          title="Уведомления: события и настройки"
          disabled={actorId === null}
        >
          <Bell className="h-5 w-5" aria-hidden="true" />
          {actorId && (unreadCount !== undefined && unreadCount > 0 || unreadSummary.isError) && (
            <span aria-label={unreadSummary.isError ? "Счётчик уведомлений временно недоступен" : `Непрочитанных уведомлений: ${unreadCount}`} className="absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
              {unreadSummary.isError ? "?" : unreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent id={popoverId} aria-labelledby={headingId} className="flex w-[min(380px,calc(100vw-1rem))] max-h-[var(--radix-popover-content-available-height)] flex-col overflow-hidden p-0" align="end" collisionPadding={8}>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          <h3 id={headingId} className="font-semibold">Уведомления</h3>
          {unreadCount !== undefined && unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleMarkAllRead}
              disabled={markAllReadMutation.isPending && markAllReadMutation.variables?.token === token}
            >
              <Check className="mr-1 h-4 w-4" />
              Прочитать все
            </Button>
          )}
        </div>

        {browserNotifications.ready && (
          <div className="shrink-0 border-b px-4 py-2 text-xs">
            {browserNotifications.permission === "default" ? (
              <><Button
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs"
                disabled={browserNotifications.permissionRequestState === "pending"}
                onClick={() => { void browserNotifications.requestPermission(); }}
              >
                {browserNotifications.permissionRequestState === "pending" ? "Ожидаем ответ браузера…" : "Включить уведомления на компьютере"}
              </Button>
              {browserNotifications.permissionRequestState === "pending" && <p role="status" className="mt-2 text-muted-foreground">Ожидаем разрешение браузера. Проверьте окно запроса или настройки сайта рядом с адресной строкой. Пока можно продолжать работу.</p>}
              {browserNotifications.permissionRequestState === "default" && <p role="status" className="mt-2 text-muted-foreground">Разрешение не получено. Если браузер не показал запрос, откройте настройки этого сайта рядом с адресной строкой и разрешите уведомления. Обновления по-прежнему доступны в колокольчике.</p>}
              </>
            ) : browserNotifications.permission === "denied" ? (
              <div className="space-y-2 text-muted-foreground">
                <p className="font-medium text-foreground">Как включить уведомления в Chrome</p>
                <p>Уведомления на компьютере заблокированы в настройках сайта</p>
                <ol className="list-decimal space-y-1 pl-4">
                  <li>Нажмите значок настроек сайта слева от адреса страницы.</li>
                  <li>Откройте «Настройки сайтов» и для «Уведомления» выберите «Разрешить».</li>
                  <li>Вернитесь на эту вкладку. Разрешение проверится автоматически.</li>
                </ol>
                <a className="inline-block text-primary underline underline-offset-2" href="https://support.google.com/chrome/answer/3220216" target="_blank" rel="noopener noreferrer">Инструкция Chrome</a>
                <p>Обновления также доступны в колокольчике.</p>
              </div>
            ) : browserNotifications.permission === "granted" ? (
              <p className="flex items-center gap-2 text-muted-foreground"><Check className="h-4 w-4 shrink-0" aria-hidden="true" />Уведомления на компьютере включены</p>
            ) : <span className="text-muted-foreground">Этот браузер не поддерживает системные уведомления на этой странице. Обновления доступны в колокольчике.</span>}
          </div>
        )}

        {markReadMutation.isError && markReadMutation.variables?.token === token && (
          <p role="alert" className="px-4 py-2 text-sm text-destructive">Не удалось отметить уведомление. Попробуйте ещё раз.</p>
        )}

        <div className="min-h-0 max-h-[min(400px,calc(var(--radix-popover-content-available-height)-6rem))] flex-1 overflow-y-auto overscroll-contain">
          {isLoading ? (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
              Загрузка...
            </div>
          ) : isError ? (
            <div role="alert" className="py-8 text-center text-sm text-muted-foreground">
              Не удалось загрузить уведомления
            </div>
          ) : notifications.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-sm text-muted-foreground">
              <Bell className="mb-2 h-8 w-8 opacity-50" />
              <p>Нет уведомлений</p>
            </div>
          ) : (
            <div className="divide-y">
              {notifications.map((notification) => (
                <div
                  key={notification.id}
                  className={cn(
                    "flex items-start gap-2 px-4 py-3",
                    !notification.read && "bg-blue-50 dark:bg-blue-950/20"
                  )}
                >
                  <button
                    type="button"
                    onClick={() => handleNotificationClick(notification)}
                    className="min-w-0 flex-1 rounded-sm text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-center gap-2">
                        <p id={`${headingId}-${notification.id}`} className="min-w-0 break-words text-sm font-medium leading-snug">
                          {isQueueEvent(notification) ? "Заявка поступила в очередь" : notification.title}
                        </p>
                        {!notification.read && (
                          <span role="img" aria-label="Непрочитано" className="h-2 w-2 shrink-0 rounded-full bg-blue-500" />
                        )}
                      </div>
                      <p className="break-words text-sm text-muted-foreground line-clamp-2">
                        {isQueueEvent(notification) ? "Обращение поступило в отдел для обработки." : notification.message}
                      </p>
                      {notification.currentTask?.phase?.label && <p className="text-sm font-medium">Сейчас: {notification.currentTask.phase.label}</p>}
                      <p className="text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(notification.createdAt), {
                          addSuffix: true,
                          locale: ru,
                        })}
                      </p>
                    </div>
                  </div>
                  </button>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-8 min-h-8 w-8 min-w-8 shrink-0 self-start p-0"
                    title={notification.read ? "Прочитано" : "Отметить прочитанным"}
                    aria-label={notification.read ? "Прочитано" : "Отметить прочитанным"}
                    aria-describedby={`${headingId}-${notification.id}`}
                    aria-busy={singleReadPending && markReadMutation.variables?.notificationId === notification.id}
                    disabled={notification.read || singleReadPending || allReadPending}
                    onClick={() => handleMarkRead(notification)}
                  >
                    <Check className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
