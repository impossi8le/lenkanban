"use client";

import { createContext, useContext, type ReactNode } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { RequestAge } from "./RequestAge";
import { useTaskChanges } from "@/hooks/useTaskChanges";
import { useTaskChangeViewed } from "@/hooks/useTaskChangeViewed";
import type { TaskType } from "@/components/kanban/Card";
import type { TaskChangesResponse } from "@/lib/task-change-contract";
import { useNotificationSummary } from "@/hooks/useNotificationSummary";

const ChangesContext = createContext<{ byTask?: TaskChangesResponse["byTask"]; notifications?: Record<string, number> } | null>(null);
function ChangesReader({ projectId, children }: { projectId: string; children: ReactNode }) {
  const changes = useTaskChanges(projectId);
  const notifications = useNotificationSummary();
  return <ChangesContext.Provider value={{ byTask: changes.data?.byTask, notifications: notifications.byTask }}>{children}</ChangesContext.Provider>;
}
export function TaskChangesProvider({ projectId, enabled, children }: { projectId?: string; enabled: boolean; children: ReactNode }) {
  const client = useContext(QueryClientContext);
  const inherited = useContext(ChangesContext);
  return !inherited && client && enabled && projectId ? <ChangesReader projectId={projectId}>{children}</ChangesReader> : children;
}

const dateFormatter = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
function Timestamp({ label, value }: { label: string; value?: string }) {
  const date = value ? new Date(value) : null;
  return <span className="whitespace-nowrap">{label}: {date && Number.isFinite(date.getTime()) ? <time dateTime={date.toISOString()}>{dateFormatter.format(date)}</time> : "не указано"}</span>;
}
function DateRows({ task, latestAt, notice }: { task: TaskType; latestAt?: string; notice?: string }) {
  const created = Date.parse(task.createdAt ?? ""), updated = Date.parse(latestAt ?? "");
  return <>
    {Number.isFinite(updated) && Number.isFinite(created) && updated > created && <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm text-muted-foreground" aria-label="Последнее обновление, московское время"><Timestamp label="Обновлено" value={latestAt}/><RequestAge createdAt={latestAt!} precision="minutes"/></div>}
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-left text-sm text-muted-foreground" aria-label="Создание обращения, московское время"><Timestamp label="Создано" value={task.createdAt}/>{notice && <span className="ml-auto text-right font-medium text-primary" aria-label="Непросмотренное изменение">{notice}</span>}</div>
  </>;
}
export function TaskCardDates({ task }: { task: TaskType }) {
  const changes = useContext(ChangesContext);
  const summary = changes?.byTask?.[task.id];
  const unread = changes?.notifications?.[task.id] ?? 0;
  return <><DateRows task={task} latestAt={changes ? summary?.latestVisibleChange?.at ?? task.lastVisibleWorkAt : task.updatedAt} notice={summary?.unseen ? summary.latestVisibleChange?.label : undefined}/>{unread > 0 && <span className="inline-flex w-fit items-center rounded-md bg-primary/10 px-2 py-1 text-xs font-medium text-primary" aria-label={`Непрочитанных уведомлений по заявке: ${unread}`}>Новых событий: {unread}</span>}</>;
}
function DetailWithChanges({ task, ready }: { task: TaskType; ready: boolean }) {
  const changes = useTaskChanges(task.projectId, task.id);
  const summary = changes.data?.byTask[task.id];
  const receipt = useTaskChangeViewed({ actorId: changes.actorId, projectId: task.projectId, taskId: task.id,
    snapshotToken: summary?.snapshotToken, unseen: summary?.unseen, notificationCount: summary?.notificationCount,
    ready: ready && changes.isFetchedAfterMount && !changes.isFetching && !changes.isError && Boolean(summary),
  });
  const latest = summary?.latestVisibleChange;
  return <div className="space-y-2 text-sm text-muted-foreground" aria-label="Даты и последнее изменение обращения">
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"><Timestamp label="Создано" value={task.createdAt}/>{task.createdAt && <RequestAge createdAt={task.createdAt} precision="minutes"/>}</div>
    {latest && <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"><Timestamp label="Обновлено" value={latest.at}/><RequestAge createdAt={latest.at} precision="minutes"/><span className="w-full text-foreground">{latest.label}</span></div>}
    {receipt.status === "failed" && <p role="status">Не удалось сохранить просмотр. <button type="button" className="underline underline-offset-4" onClick={receipt.retry}>Повторить</button></p>}
  </div>;
}
export function TaskChangeDetails({ task, ready = true }: { task: TaskType; ready?: boolean }) {
  const client = useContext(QueryClientContext);
  return client ? <DetailWithChanges task={task} ready={ready}/> : <div className="text-sm text-muted-foreground"><Timestamp label="Создано" value={task.createdAt}/></div>;
}
