"use client";
import {SearchHighlight,TaskSearchContext} from "@/components/ui/SearchHighlight";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { TaskCardDates } from "@/components/task/TaskChangeInformation";
import { useContext } from "react";
import { RequestActionsContext, RequestQuickTake } from "@/components/task/RequestQuickTake";
import { decodeRequestDescription, isUrgentRequest, crmOrderUrl } from "@/lib/request-presentation";
import { cn } from "@/lib/utils";
import { useRouter } from "next/navigation";
import type { Attachment } from "@/types/attachment";

export type TaskType = {
  id: string;
  title: string;
  description?: string | null;
  descriptionEditedAt?: string | null;
  status?: string; // Legacy field, optional during transition
  columnId?: string | null; // New: references ProjectColumn
  column?: {
    id: string;
    name: string;
    color: string;
  } | null;
  priority: string;
  position: number;
  projectId: string;
  project?: { id: string; name: string } | null;
  deadline?: Date | null;
  createdAt?: string;
  updatedAt?: string;
  lastVisibleWorkAt?: string;
  createdBy?: { id: string; name: string | null; primaryDepartment?: { name: string } | null } | null;
  request?: {state: string; executorId: string | null; beznalPhase?: "WAITING" | "INVOICED" | null; isPersonal?: boolean; author?: {id:string;name:string|null}|null; executor?: {id:string;name:string|null}|null} | null;
  queueArrival?: { epoch: number; unseen: boolean } | null;
  createdById?: string; // User who created the task
  assignees?: Array<{
    id: string;
    user: {
      id: string;
      name: string | null;
      email: string;
      avatarUrl?: string | null;
    };
  }>;
  tags?: Array<{
    id: string;
    tag: {
      id: string;
      name: string;
      color: string;
    };
  }>;
  attachments?: Attachment[];
  checklist?: {
    total: number;
    completed: number;
  } | null;
  checklistItems?: Array<{
    id: string;
    taskId: string;
    text: string;
    completed: boolean;
    position: number;
    createdAt: string;
    updatedAt: string;
  }>;
  _count?: {
    messages?: number;
  };
  unreadCount?: number;
  version?: number;
};

interface KanbanCardProps {
  canMove?: boolean;
  task: TaskType;
  isSelected?: boolean;
  onTaskSelect?: (taskId: string) => void;
  selectionDisabled?: boolean;
}

export interface KanbanCardViewProps {
  searchQuery?: string;
  task: TaskType;
  placeholderHeight?: number;
  isDragging?: boolean;
  isPending?: boolean;
  isSelected?: boolean;
  onTaskSelect?: () => void;
  selectionDisabled?: boolean;
  dragHandleProps?: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    ref?: React.Ref<HTMLButtonElement>;
    "data-kanban-drag-handle"?: string;
  };
  onOpen?: (opener?: HTMLButtonElement) => void;
  titleButtonRef?: (button: HTMLButtonElement | null) => void;
  animatePresence?: boolean;
}

export function KanbanCardView({task,onOpen,titleButtonRef,isPending=false,isSelected=false,isDragging=false,searchQuery}: KanbanCardViewProps): React.ReactElement {
  const canExecute = useContext(RequestActionsContext);
  const data=decodeRequestDescription(task.description), urgent=isUrgentRequest(task.priority);
  const author=task.request?.author?.name || task.createdBy?.name || "Сотрудник", department=task.createdBy?.primaryDepartment?.name;
  const executor=task.request ? task.request.executor?.name || task.assignees?.find(row=>row.user.id===task.request?.executorId)?.user.name : task.assignees?.[0]?.user.name;
  const waitingLabel = task.request?.state === "NEEDS_INFO" ? "Нужен ответ автора обращения" : task.request?.state === "COMPLETED" ? "Специалист отметил как решённое" : task.request?.state === "CLOSED" ? "Работа завершена" : task.request?.state === "CANCELLED" ? "Обращение отменено" : task.request?.executorId ? "Исполнитель занимается обращением" : "Ждёт специалиста";
  const order=data.details?.order, url=order?crmOrderUrl(order):null;
  return <div data-task-id={task.id} data-priority={task.priority} data-queue-unseen={task.queueArrival?.unseen || undefined} aria-busy={isPending||undefined}
    onClick={event=>{if(!(event.target as HTMLElement).closest("button,a"))onOpen?.();}}
    className={cn("request-card group relative min-w-0 max-w-full space-y-3 rounded-xl border bg-card p-4 text-card-foreground shadow-sm",urgent&&"border-2 border-red-500",task.queueArrival?.unseen&&"ring-2 ring-primary/40",isPending&&"opacity-70",isSelected&&"ring-2 ring-primary",isDragging&&"opacity-40")}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      {data.details?.category&&<span className="rounded bg-muted px-2 py-1 text-xs">{data.details.category}</span>}
    </div>
    {task.queueArrival?.unseen && <p className="text-sm font-semibold text-primary">● Новое для вас</p>}
    <TaskCardDates task={task}/>
    {urgent&&<p className="text-xs font-bold text-red-700 dark:text-red-300">{data.details?.kind==='claim'?"Срочно":"СРОЧНО"}</p>}
    {onOpen?<button ref={titleButtonRef} type="button" onClick={event=>onOpen(event.currentTarget)} aria-label={`Открыть задачу «${task.title}»`} className="min-h-11 w-full break-words text-left text-base font-bold leading-snug focus-visible:outline-2 focus-visible:outline-ring"><SearchHighlight text={task.title} query={searchQuery}/></button>:<p className="break-words text-base font-bold"><SearchHighlight text={task.title} query={searchQuery}/></p>}
    {searchQuery&&<TaskSearchContext task={task} query={searchQuery}/>}
    {task.request?.isPersonal&&<p className="text-sm font-semibold text-primary">Персональная заявка</p>}
    {!searchQuery&&data.body&&<p className="line-clamp-2 break-words text-sm text-muted-foreground">{data.body.replace(/<[^>]*>/g,'').trim()}</p>}
    {data.details?.kind==='beznal'&&<div className="space-y-1 break-words text-sm">{data.details.company&&<p>{data.details.company}</p>}{data.details.amount&&<p>Сумма: {data.details.amount} ₽</p>}{data.details.invoiceNumber&&<p>Счёт № {data.details.invoiceNumber}</p>}{data.details.orderNumber&&<p>Заказ № {data.details.orderNumber}</p>}</div>}
    {data.details?.kind==='claim'&&<div className="space-y-1 break-words text-sm">{url&&<a href={url} target="_blank" rel="noopener noreferrer" className="font-semibold text-primary underline">Заказ № {order} ↗</a>}<p>{data.details.client}</p><p>{data.details.phone}</p></div>}
    <div className="rounded-lg bg-muted/60 p-3 text-sm"><p className="font-semibold">{author}</p>{department&&<p className="mt-1 text-muted-foreground">{department}</p>}</div>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0 space-y-1"><p className="text-sm text-muted-foreground">{waitingLabel}</p>{executor && <p className="text-sm font-semibold">Исполнитель: {executor}</p>}</div>
      {task.request?.state==='SUBMITTED'&&!task.request.executorId&&Number.isInteger(task.version)&&<RequestQuickTake key={`${task.id}:${task.version}`} taskId={task.id} projectId={task.projectId} version={task.version!}/>}
      {canExecute && onOpen && task.request && ["IN_PROGRESS", "NEEDS_INFO", "COMPLETED"].includes(task.request.state) && <button type="button" onClick={event => onOpen(event.currentTarget)} className="min-h-11 rounded-md border border-primary px-3 text-sm font-semibold text-primary hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring">Открыть обращение →</button>}
    </div>
    {!!task._count?.messages&&<p className="text-xs text-muted-foreground">Комментарии: {task._count.messages}{task.unreadCount?` · новых: ${task.unreadCount}`:''}</p>}
  </div>;
}

export function KanbanCard({
  canMove = false,
  task,
  isSelected = false,
  onTaskSelect,
  selectionDisabled = false,
}: KanbanCardProps): React.ReactElement {
  const router = useRouter();
  const {
    setNodeRef,
    setActivatorNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
    rect,
    active,
  } = useSortable({
    id: task.id,
    disabled: !canMove,
    data: {
      type: "Task",
      task,
    },
  });

  return (
    <div
      ref={setNodeRef}
      style={{
        touchAction: "auto",
        transition,
        transform: CSS.Transform.toString(transform),
      }}
      className={cn(
        "min-w-0 shrink-0 rounded-2xl",
      )}
    >
      <KanbanCardView
        task={task}
        isSelected={isSelected}
        onTaskSelect={onTaskSelect ? () => onTaskSelect(task.id) : undefined}
        selectionDisabled={selectionDisabled}
        isDragging={isDragging}
        placeholderHeight={active?.rect.current.initial?.height ?? rect.current?.height}
        dragHandleProps={canMove ? {
          disabled: !canMove,
          ...attributes,
          ...listeners,
          ref: setActivatorNodeRef,
          style: { touchAction: "none" },
          "aria-label": `Переместить задачу «${task.title}»`,
          "data-kanban-drag-handle": "",
        } : undefined}
        onOpen={() => router.push(`/projects/${task.projectId}/tasks/${task.id}`)}
      />
    </div>
  );
}
