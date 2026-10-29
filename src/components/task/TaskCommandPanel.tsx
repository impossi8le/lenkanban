"use client";

import { TaskDetailPanel, type TaskEditCapabilities } from "@/components/task/TaskDetailPanel";
import type { TaskLifecycleSnapshot } from "@/components/task/TaskRequestLifecycleControls";
import { apiFetch } from "@/lib/api";
import { useSession } from "next-auth/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import type { TaskType } from "@/components/kanban/Card";
import { useTaskDetailRealtime } from "@/hooks/useTaskDetailRealtime";
import { useTaskScalarCommand } from "@/hooks/useTaskScalarCommand";
import { useRequestQueueSeen } from "@/hooks/useRequestQueueSeen";
import { getBrowserTelemetryClient } from "@/lib/telemetry/client";
import { Button } from "@/components/ui/button";

export type TaskCommandPanelProps = { projectId: string; taskId: string; task: TaskType; initialActorId?: string; onClose: () => void; onDeleted?: () => void; onAuthoritativeRead?: (task: TaskType) => void; headingLevel?: 1 | 2 };
export function TaskCommandPanel(props: TaskCommandPanelProps) {
  const { data: session, status } = useSession();
  const actor = useRef(props.initialActorId ?? session?.user?.id);
  if (!actor.current && session?.user?.id) actor.current = session.user.id;
  if (status === "loading") return <p role="status">Проверка учётной записи…</p>;
  if (!session?.user?.id) return <div role="alert">Войдите заново, чтобы открыть карточку.</div>;
  if (actor.current !== session.user.id || props.initialActorId && props.initialActorId !== session.user.id) return <div role="alert" className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-background p-4"><p>Учётная запись изменилась. Карточка скрыта до обновления страницы.</p><Button onClick={() => window.location.reload()}>Обновить страницу</Button></div>;
  return <TaskCommandContent key={JSON.stringify([session.user.id, props.projectId, props.taskId])} {...props} />;
}
function TaskCommandContent({ projectId, taskId, task, onClose, onDeleted, onAuthoritativeRead, headingLevel }: TaskCommandPanelProps) {
  const client = useQueryClient();
  const { data: session } = useSession();
  const actorId = session?.user?.id;
  const callbacks = useRef({ onClose, onDeleted }); callbacks.current = { onClose, onDeleted };
  const alive = useRef(true), deleting = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const command = useTaskScalarCommand(task, projectId, taskId, onAuthoritativeRead);
  const lifecycle = useQuery({
    queryKey: ["task-lifecycle", taskId, actorId],
    queryFn: () => apiFetch<TaskLifecycleSnapshot>(`/api/tasks/${taskId}/lifecycle`),
    enabled: Boolean(actorId), retry: false, staleTime: 0, refetchOnMount: "always",
  });
  const authority = lifecycle.data;
  const freshAuthority = !lifecycle.isError && !lifecycle.isFetching && authority?.taskId === taskId && authority.projectId === projectId
    && Number.isInteger(authority.version) && authority.version >= 0 && authority.version <= 2147483647
    && authority.version === command.task.version && !authority.deleted;
  const editCapabilities: TaskEditCapabilities = {
    canEditFields: Boolean(freshAuthority && authority?.marked === false && authority.permissions?.canEditFields === true),
    canEditDescription: Boolean(freshAuthority && authority?.permissions?.canEditDescription === true),
    canSetDeadline: Boolean(freshAuthority && authority?.marked === false && authority.permissions?.canSetDeadline === true),
    canUseLegacyAssignees: Boolean(freshAuthority && authority?.marked === false && authority.permissions?.canUseLegacyAssignees === true),
  };
  const queueSeen = useRequestQueueSeen({
    actorId, taskId, queueArrival: command.task.queueArrival,
    authoritative: Boolean(freshAuthority && command.task.id === taskId && command.task.projectId === projectId),
    active: command.phase === "idle",
    onAcknowledged: () => {
      void client.invalidateQueries({ queryKey: ["request-queue-unseen", actorId] });
      void client.invalidateQueries({ queryKey: ["tasks"] });
      void client.invalidateQueries({ queryKey: ["my-tasks", actorId] });
      void client.invalidateQueries({ queryKey: ["task", taskId] });
    },
    onStale: command.readInBackground,
  });
  useTaskDetailRealtime(projectId, taskId, command.readInBackground);
  // One card opening per task identity; a rerender never repeats the intent.
  useEffect(() => { getBrowserTelemetryClient()?.recordScreen("task.detail"); }, [taskId]);
  const statusRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (["unknown", "conflict", "unsupported", "readFailed", "denied"].includes(command.phase)) statusRef.current?.focus(); }, [command.phase]);
  const deletion = useMutation({
    mutationFn: async (id: string) => { const result = await fetch(`/api/tasks/${encodeURIComponent(id)}`, { method: "DELETE" }); if (!result.ok) throw new Error("DELETE_FAILED"); },
    onSuccess: () => { if (!alive.current) return; void client.invalidateQueries({ queryKey: ["tasks", projectId] }); client.removeQueries({ queryKey: ["task", taskId] }); toast.success("Задача удалена"); if (callbacks.current.onDeleted) { try { void Promise.resolve(callbacks.current.onDeleted()).catch(() => undefined); } catch { /* Deletion stays committed. */ } } else window.location.href = `/projects/${projectId}/board`; },
    onError: () => { if (alive.current) toast.error("Не удалось удалить задачу"); },
    onSettled: () => { deleting.current = false; },
  });
  const close = () => {
    if (deleting.current || command.blocked && command.phase !== "denied") {
      toast.info(deleting.current ? "Дождитесь удаления карточки."
        : command.phase === "saving" ? "Дождитесь окончания сохранения."
          : command.phase === "reading" ? "Дождитесь обновления карточки."
            : command.phase === "unknown" ? "Сначала нажмите «Повторить сохранение» в карточке."
              : "Сначала нажмите «Обновить карточку», затем повторите действие.");
      // Error recovery remains visible until the user acts. Keep focus on the
      // close control while a transient saving/reading status is about to leave.
      if (["unknown", "conflict", "unsupported", "readFailed"].includes(command.phase)) statusRef.current?.focus();
      return;
    }
    callbacks.current.onClose();
  };
  const commandSave = command.save;
  const save = useCallback((...args: Parameters<typeof commandSave>) => {
    if (deleting.current) return;
    const [, data] = args;
    // A column move is its own catalogued action; every other scalar edit is an update.
    // The actual write transport completes this intent once. Its canonical read
    // shares the ID but never completes the same telemetry token a second time.
    const startTelemetry: Parameters<typeof commandSave>[3] = () => {
      try {
        const client = getBrowserTelemetryClient();
        const action = client?.beginAction(Object.hasOwn(data, "columnId") ? "task.move" : "task.update");
        if (action) return { actionId: action.actionId, onResult: result => { try { client?.finishAction(action, result); } catch { /* Diagnostics cannot affect the command. */ } } };
      } catch { /* Saving remains available if telemetry fails. */ }
      return undefined;
    };
    commandSave(args[0], args[1], args[2], startTelemetry);
  }, [commandSave]);
  const status = command.phase === "idle" ? null : <div ref={statusRef} tabIndex={-1} role={command.phase === "saving" || command.phase === "reading" ? "status" : "alert"} className="min-w-0 space-y-3 rounded-md border p-3">
    {command.phase === "saving" && <p>Сохранение изменений…</p>}
    {command.phase === "reading" && <p>Обновляем карточку…</p>}
    {command.phase === "unknown" && <><p className="font-medium">Сохранение пока не подтверждено</p><p>Сервер не подтвердил сохранение. Нажмите «Повторить сохранение», чтобы проверить результат. Другие изменения временно недоступны.</p><Button className="h-auto whitespace-normal" onClick={command.retry}>Повторить сохранение</Button></>}
    {command.phase === "conflict" && <><p className="font-medium">Изменение не сохранено</p><p>Не удалось сохранить изменение. Обновите карточку и повторите действие.</p><Button className="h-auto whitespace-normal" onClick={command.refresh}>Обновить карточку</Button></>}
    {command.phase === "unsupported" && <><p className="font-medium">Изменение недоступно</p><p>Этот параметр сейчас нельзя изменить. Обновите карточку, чтобы увидеть доступные действия.</p><Button className="h-auto whitespace-normal" onClick={command.refresh}>Обновить карточку</Button></>}
    {command.phase === "readFailed" && <><p>Не удалось загрузить актуальные данные. Нажмите «Обновить карточку», чтобы продолжить.</p><Button className="h-auto whitespace-normal" onClick={command.refresh}>Обновить карточку</Button></>}
    {command.phase === "rejected" && <p>Не удалось сохранить изменение. Проверьте введённые данные и повторите действие.</p>}
  </div>;
  if (command.phase === "denied") return <div ref={statusRef} tabIndex={-1} role="alert" className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-background p-4"><p>Карточка недоступна или права изменились.</p><Button onClick={() => callbacks.current.onClose()}>Закрыть карточку</Button></div>;
  return <TaskDetailPanel key={command.generation} task={command.task} onClose={close} headingLevel={headingLevel}
    editCapabilities={editCapabilities}
    onLocalEditsChange={command.reportLocalEdits} onLifecycleChanged={command.readInBackground}
    onDelete={command.task.request || authority?.marked === true ? undefined : id => { if (!command.blocked && !deleting.current && !deletion.isPending && confirm("Вы уверены, что хотите удалить эту задачу?")) { deleting.current = true; deletion.mutate(id); } }}
    onSave={save} isSaving={command.blocked || deletion.isPending} scalarSaveBlocked={command.blocked || deletion.isPending} saveStatus={<>{status}{queueSeen.status === "failed" && <div role="status" className="space-y-2 rounded-md border p-3"><p>Не удалось отметить обращение просмотренным. Отметка «Новое для вас» пока сохранена.</p><Button onClick={queueSeen.retry}>Повторить отметку просмотра</Button></div>}</>} />;
}
