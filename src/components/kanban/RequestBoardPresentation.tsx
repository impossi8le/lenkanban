"use client";

import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { BeznalDemoCard } from "./BeznalDemoCard";
import { KanbanCardView, type TaskType } from "./Card";
import { TaskCardDates, TaskChangesProvider } from "@/components/task/TaskChangeInformation";
import { getRequestBoardPhase, requestDisplayState } from "@/lib/request-board-phase";
export { requestDisplayState } from "@/lib/request-board-phase";
import { decodeRequestDescription, isUrgentRequest } from "@/lib/request-presentation";
import { compareRequestsForDisplay, compareRequestsByVisibleWork } from "@/lib/request-display-order";
import { QueueUnseenFilter } from "@/components/task/QueueUnseenFilter";
import { useNotificationSummary } from "@/hooks/useNotificationSummary";
import { matchesTaskSearch } from "@/lib/search-context";
import { SearchHighlight, TaskSearchContext } from "@/components/ui/SearchHighlight";

const STAGES = [
  { state: "SUBMITTED", name: "Новые", hint: "Ждут специалиста", color: "#d64a59" },
  { state: "IN_PROGRESS", name: "В работе", hint: "Исполнитель занимается обращением", color: "#3379d0" },
  { state: "NEEDS_INFO", name: "Ждём сотрудника", hint: "Нужен ответ автора", color: "#c49127" },
  { state: "COMPLETED", name: "Решено", hint: "Специалист выполнил обращение", color: "#32a47a" },
] as const;
const ARCHIVE = [
  { state: "CLOSED", name: "Закрыто", hint: "Закрытые обращения", color: "#64748b" },
  { state: "CANCELLED", name: "Отменено", hint: "Отменённые обращения", color: "#64748b" },
] as const;
const CLAIM_STAGES = [{ ...STAGES[0], name: "Ждёт сотрудника", hint: "Обращение ещё никто не взял в работу" }, STAGES[1]];
const BEZNAL_STAGES = [
  { state: "WAITING", name: "Ждут обработки", hint: "Счёт ещё не прикреплён", color: "#d64a59" },
  { state: "INVOICED", name: "Со счётом", hint: "Файл прикреплён к обращению", color: "#32a47a" },
];
const CLOSED_STAGES = [STAGES[3], ARCHIVE[0]];
const LIST_FILTERS = [
  { value: "open", name: "Все открытые" }, { value: "new", name: "Новые" },
  { value: "work", name: "В работе" }, { value: "closed", name: "Закрытые — архив" },
  { value: "all", name: "Все, включая закрытые" },
] as const;
type ListFilter = typeof LIST_FILTERS[number]["value"];
const isClosed = (state: string) => ["COMPLETED", "CLOSED", "CANCELLED"].includes(state);
const outcome = (state: string) => state === "COMPLETED" ? "Работа выполнена"
  : state === "CLOSED" ? "Обращение закрыто" : state === "CANCELLED" ? "Помощь отменена" : state === "NEEDS_INFO" ? "Нужен ответ автора" : "";

/** Presentation only: read access and command permissions remain server decisions. */
type PresentationProps = {
  tasks: readonly TaskType[];
  projectId?: string;
  claim?: boolean;
  beznal?: boolean;
  defaultView?: "board" | "list";
  onOpen: (task: TaskType, opener?: HTMLButtonElement) => void;
  titleButtonRef?: (taskId: string, button: HTMLButtonElement | null) => void;
  unseenOnly?: boolean;
  onUnseenOnlyChange?: (value: boolean) => void;
  unseenCount?: number | null;
  readError?: boolean;
  readPending?: boolean;
  onRetryRead?: () => void;
};
export function RequestBoardPresentation(props: PresentationProps) {
  const client = useContext(QueryClientContext);
  return client ? <NotificationPresentation {...props}/> : <RequestBoardPresentationView {...props}/>;
}
function NotificationPresentation(props: PresentationProps) {
  const notifications = useNotificationSummary();
  return <RequestBoardPresentationView {...props} notifications={notifications}/>;
}
function RequestBoardPresentationView({ tasks, projectId, claim = false, beznal = false, onOpen, titleButtonRef, defaultView = "board", unseenOnly: controlledUnseen, onUnseenOnlyChange, unseenCount, readError = false, readPending = false, onRetryRead, notifications }: PresentationProps & { notifications?: ReturnType<typeof useNotificationSummary> }) {
  const [localUnseen, setLocalUnseen] = useState(false);
  const boardId = projectId ?? tasks[0]?.projectId;
  const notificationCount = notifications?.data && boardId ? notifications.byProject?.[boardId] ?? 0 : undefined;
  const unseenOnly = controlledUnseen ?? localUnseen;
  const setUnseenOnly = (value: boolean) => { setLocalUnseen(value); onUnseenOnlyChange?.(value); };
  const [view, setView] = useState(defaultView);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [urgentOnly, setUrgentOnly] = useState(false);
  const [statusFilter, setStatusFilter] = useState<ListFilter>("open");
  const archivedSection = statusFilter === "closed";
  const client = useContext(QueryClientContext);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [uploadProof, setUploadProof] = useState<{ id: string; expectedUrls: string[]; previousUrls: string[]; version?: number } | null>(null);
  const cardNodes = useRef(new Map<string, HTMLDivElement>());
  const scrolledId = useRef<string | null>(null);
  const records = useMemo(() => [...(beznal ? new Map(tasks.map(task => [task.id, task])).values() : tasks)].sort(beznal ? compareRequestsByVisibleWork : compareRequestsForDisplay).map(task => {
    const data = decodeRequestDescription(task.description);
    return { task, data, state: requestDisplayState(task), urgent: isUrgentRequest(task.priority) };
  }).filter(row => row.state !== "DRAFT"), [tasks, beznal]);
  const displayState = (state: string, task?: TaskType) => getRequestBoardPhase(task ?? { request: { state } }, beznal, claim).code;
  const stages = beznal ? archivedSection ? [ARCHIVE[0]] : BEZNAL_STAGES : archivedSection ? CLOSED_STAGES : claim ? CLAIM_STAGES : STAGES.slice(0, 3);
  const categories = [...new Set(records.map(row => row.data.details?.category).filter((value): value is string => Boolean(value)))];
  const archived = records.filter(row => isClosed(row.state));
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = records.filter(({ task, data, urgent }) =>
    (!unseenOnly || task.queueArrival?.unseen === true) &&
    (!urgentOnly || urgent) && (!category || data.details?.category === category) &&
    (!normalizedQuery || matchesTaskSearch(task, normalizedQuery)));

  const visible = filtered.filter(row => view === "board" ? stages.some(stage => stage.state === displayState(row.state, row.task))
    : (!beznal && statusFilter === "all") || (statusFilter === "closed" ? isClosed(row.state)
      : statusFilter === "new" ? beznal ? displayState(row.state, row.task) === "WAITING" : row.state === "SUBMITTED"
        : statusFilter === "work" ? beznal ? displayState(row.state, row.task) === "INVOICED" : ["IN_PROGRESS", "NEEDS_INFO"].includes(row.state) : !isClosed(row.state)));
  const hasSearchFilters = Boolean(query || category || urgentOnly || unseenOnly);
  const hasFilters = hasSearchFilters || statusFilter !== "open";
  const filterName = (option: typeof LIST_FILTERS[number]) => beznal && option.value === "new" ? "Ждут обработки" : beznal && option.value === "work" ? "Со счётом" : claim && option.value === "new" ? "Ждёт сотрудника" : option.name;
  const sectionTitle = view === "list" ? filterName(LIST_FILTERS.find(option => option.value === statusFilter)!) : archivedSection ? "Архив" : "Текущие обращения";
  const emptyMessage = hasSearchFilters ? "По выбранным фильтрам обращений нет. Попробуйте сбросить фильтры."
    : archivedSection ? "В архиве пока нет обращений." : "По выбранному фильтру обращений пока нет.";

  useEffect(() => {
    if (!beznal) return;
    const committed = (event: Event) => {
      const taskId: unknown = (event as CustomEvent<{ taskId?: unknown }>).detail?.taskId;
      if (typeof taskId !== "string") return;
      const row = records.find(row => row.task.id === taskId);
      if (!row) return;
      const urls = (event as CustomEvent<{ attachmentUrls?: unknown }>).detail?.attachmentUrls;
      setUploadProof({ id: taskId, expectedUrls: Array.isArray(urls) && urls.length <= 5 && urls.every(url => typeof url === "string") ? urls : [], previousUrls: (row.task.attachments ?? []).map(file => file.url), version: row.task.version });
      setHighlightedId(taskId); scrolledId.current = null;
      setQuery(""); setCategory(""); setUrgentOnly(false); setView("board");
      setStatusFilter(isClosed(row.state) ? "closed" : "open");
      void client?.invalidateQueries({ queryKey: ["tasks", row.task.projectId] });
      void client?.invalidateQueries({ queryKey: ["project", row.task.projectId] });
    };
    window.addEventListener("beznal:attachment-committed", committed);
    return () => window.removeEventListener("beznal:attachment-committed", committed);
  }, [beznal, records, client]);
  const highlighted = records.find(row => row.task.id === highlightedId);
  const currentUrls = new Set(highlighted?.task.attachments?.map(file => file.url) ?? []);
  const confirmedHighlight = highlighted && !readPending && uploadProof?.id === highlightedId && (isClosed(highlighted.state)
    || uploadProof.expectedUrls.length > 0 && uploadProof.expectedUrls.every(url => currentUrls.has(url))
    || uploadProof.version !== undefined && highlighted.task.version !== undefined && highlighted.task.version > uploadProof.version
    || [...currentUrls].some(url => !uploadProof.previousUrls.includes(url)));
  useEffect(() => {
    if (!beznal || !highlightedId || !confirmedHighlight || scrolledId.current === highlightedId) return;
    const frame = requestAnimationFrame(() => {
      const node = cardNodes.current.get(highlightedId);
      if (node) { node.scrollIntoView?.({ behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center", inline: "nearest" }); scrolledId.current = highlightedId; }
    });
    return () => cancelAnimationFrame(frame);
  }, [beznal, highlightedId, confirmedHighlight, tasks, view, statusFilter]);
  const active = records.filter(row => !isClosed(row.state));
  return <TaskChangesProvider projectId={tasks[0]?.projectId} enabled><div className="request-board-shell">
    {beznal && highlighted && <p role="status" className="mb-4 rounded-lg border border-green-600 bg-green-50 p-4 text-base text-green-900 dark:bg-green-950 dark:text-green-200">Файл прикреплён к «{highlighted.task.title}». {!confirmedHighlight ? "Обновляем данные обращения…" : isClosed(highlighted.state) ? "Обращение остаётся в архиве." : getRequestBoardPhase(highlighted.task, true).code === "INVOICED" ? "Обращение теперь в колонке «Со счётом»." : "Обращение в колонке «Ждут обработки»."}</p>}
    <div className="request-board-metrics" aria-label="Сводка обращений">
      {beznal ? <><div><strong>{readError ? "—" : active.length}</strong><span>Текущие обращения</span></div><div><strong>{readError ? "—" : active.filter(row => getRequestBoardPhase(row.task, true).code === "WAITING").length}</strong><span>Ждут обработки</span></div><div><strong>{readError ? "—" : active.filter(row => getRequestBoardPhase(row.task, true).code === "INVOICED").length}</strong><span>Со счётом</span></div></> : <><div><strong>{readError ? "—" : visible.length}</strong><span>{sectionTitle}</span></div>
      <div><strong className="text-red-700 dark:text-red-300">{visible.filter(row => row.urgent).length}</strong><span>{claim ? "Срочно" : "Срочных"}</span></div>
      <div><strong>{visible.filter(row => row.state === "SUBMITTED").length}</strong><span>{claim ? "Ждёт сотрудника" : "Ждут специалиста"}</span></div></>}
    </div>
    {view === "board" && <div className="request-view-switch flex-wrap max-w-full" role="group" aria-label="Раздел обращений">
      <button type="button" className="min-h-12" aria-pressed={!archivedSection} onClick={() => setStatusFilter("open")}>Текущие обращения</button>
      <button type="button" className="min-h-12" aria-pressed={archivedSection} onClick={() => setStatusFilter("closed")}>Архив{archived.length > 0 ? ` · ${archived.length}` : ""}</button>
    </div>}
    <section aria-label="Пояснение раздела" className="mb-4 space-y-1 text-sm text-muted-foreground">
      <h2 className="font-semibold text-foreground">{sectionTitle}</h2>
      <p>{archivedSection || statusFilter === "all" ? "Закрытые обращения сохранены. Карточки, переписка и файлы доступны по прежним правам: нажмите на обращение, чтобы открыть их."
        : beznal && view === "board" ? "Прикрепите счёт — обращение появится в колонке «Со счётом». Выполненные, закрытые и отменённые обращения находятся в архиве." : "Здесь открытые обращения. Выполненные, закрытые и отменённые обращения находятся в архиве."}</p>
    </section>
    <div className="request-view-switch" role="group" aria-label="Вид обращений">
      <button type="button" className="min-h-12" aria-pressed={view === "list"} onClick={() => setView("list")}>Список</button>
      <button type="button" className="min-h-12" aria-pressed={view === "board"} onClick={() => { setView("board"); setStatusFilter(archivedSection ? "closed" : "open"); }}>Доска</button>
    </div>
    <div className="request-board-toolbar">
      {view === "list" && <label className="request-board-filter-field request-board-filter-field--status"><span>Показать</span><select className="min-h-12" aria-label="Показать" value={statusFilter} onChange={event => setStatusFilter(event.target.value as ListFilter)}>
        {LIST_FILTERS.filter(option => !beznal || option.value !== "all").map(option => <option key={option.value} value={option.value}>{filterName(option)}</option>)}
      </select></label>}
      <QueueUnseenFilter unseenOnly={unseenOnly} onChange={setUnseenOnly} count={unseenCount === null ? undefined : unseenCount ?? records.filter(row => row.task.queueArrival?.unseen).length} />
      {notifications && <div className="request-board-filter-field"><span>Уведомления</span><div className="flex min-h-11 items-center rounded-lg border px-3 text-sm" aria-label="Непрочитанные уведомления доски">Непрочитанных: {notifications.isError ? "?" : notificationCount ?? "…"}</div></div>}
      <label className="request-board-filter-field request-board-filter-field--search"><span>Поиск</span><input className="request-board-search" aria-label="Поиск обращений" maxLength={200} placeholder={`Тема, описание, автор, исполнитель${claim ? ", заказ, телефон" : ""}…`} value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className="request-board-filter-field"><span>Срочность</span><div className="request-board-segment" role="group" aria-label="Фильтр срочности">
        <button type="button" className="min-h-11" aria-pressed={!urgentOnly} onClick={() => setUrgentOnly(false)}>Все</button>
        <button type="button" className="min-h-11" aria-pressed={urgentOnly} onClick={() => setUrgentOnly(true)}>{claim ? "Срочно" : "Срочные"}</button>
      </div></div>
      <label className="request-board-filter-field"><span>Категория</span><select aria-label="Категория" value={category} onChange={event => setCategory(event.target.value)}>
        <option value="">Все категории</option>{categories.map(value => <option key={value}>{value}</option>)}
      </select></label>
      <button type="button" className="request-board-reset min-h-11" disabled={!hasFilters} onClick={() => { setQuery(""); setCategory(""); setUrgentOnly(false); setUnseenOnly(false); setStatusFilter("open"); }}>Сбросить фильтры</button>
    </div>
    {notifications?.isError && <p role="status" className="mb-3 text-sm text-muted-foreground">Не удалось обновить уведомления. <button type="button" className="underline" onClick={() => void notifications.refetch()}>Повторить</button></p>}
    {readError ? <div role="alert" className="space-y-2 rounded-xl border p-4"><p>Не удалось загрузить задачи. Повторите загрузку.</p><button type="button" className="min-h-11 rounded-md border px-4" disabled={readPending} onClick={onRetryRead}>Повторить загрузку</button></div> : view === "list" ? <section className="request-list" aria-label="Список обращений">
      {visible.map(({ task, state, urgent, data }) => {
        if (beznal) return <div key={task.id} ref={node => { if (node) cardNodes.current.set(task.id, node); else cardNodes.current.delete(task.id); }}><BeznalDemoCard searchQuery={query} task={task} archived={isClosed(state)} highlighted={task.id === highlightedId && Boolean(confirmedHighlight)} onOpen={opener => onOpen(task, opener)} titleButtonRef={button => titleButtonRef?.(task.id, button)} /></div>;
        const stage = [...(beznal ? BEZNAL_STAGES : claim ? CLAIM_STAGES : STAGES), ...CLOSED_STAGES].find(stage => stage.state === displayState(state, task));
        const executor = task.request ? task.request.executor?.name || task.assignees?.find(row=>row.user.id===task.request?.executorId)?.user.name : task.assignees?.[0]?.user.name;
        return <article className={`request-list-row${task.queueArrival?.unseen ? " bg-primary/5 ring-1 ring-inset ring-primary/40" : ""}`} key={task.id} data-queue-unseen={task.queueArrival?.unseen || undefined}>
          <div className="request-list-main">
            <button type="button" className={claim ? "request-list-title min-h-11" : "request-list-title"} ref={button => titleButtonRef?.(task.id, button)} onClick={event => onOpen(task, event.currentTarget)} aria-label={`Открыть обращение «${task.title}»`}><SearchHighlight text={task.title} query={query}/></button>
            <TaskSearchContext task={task} query={query}/>
            {task.request?.isPersonal && <p className="text-sm font-semibold text-primary">Персональная заявка</p>}
            {task.queueArrival?.unseen && <p className="text-sm font-semibold text-primary">● Новое для вас</p>}
            {urgent && <p className="request-list-urgent">{data.details?.kind === "claim" ? "Срочно" : "Срочно"}</p>}
            <p className="request-list-meta"><span>Автор: {task.request?.author?.name || task.createdBy?.name || "Сотрудник"}</span><span>{executor ? `Исполнитель: ${executor}` : isClosed(state) ? "Исполнитель не указан" : "Ждёт специалиста"}</span></p>
          </div>
          <span className="request-list-state" data-state={state}>{stage?.name ?? "Обращение"}{outcome(state) ? ` · ${outcome(state)}` : ""}</span>
          <div className="request-list-time space-y-1"><TaskCardDates task={task}/></div>
        </article>;
      })}
      {!visible.length && <p className="request-list-empty">{emptyMessage}</p>}
    </section> : <div className="request-board-columns" role="region" aria-label="Колонки обращений" tabIndex={0} style={{ "--request-column-count": stages.length } as React.CSSProperties}>
      {stages.map(stage => {
        const rows = filtered.filter(row => displayState(row.state, row.task) === stage.state);
        return <section className="request-board-column" key={stage.state} aria-label={stage.name} data-request-stage={stage.state} style={{ "--request-stage-color": stage.color } as React.CSSProperties}>
          <div className="request-board-column-head"><h2><span className="request-stage-dot" />{stage.name}<span className="request-stage-count">{rows.length}</span></h2><p>{stage.hint}</p></div>
          <div className="request-board-cards">{rows.map(({ task, state }) => <div key={task.id} ref={node => { if (node) cardNodes.current.set(task.id, node); else cardNodes.current.delete(task.id); }}>{outcome(state) && <p className="px-3 pt-2 text-sm text-muted-foreground">{outcome(state)}</p>}{beznal ? <BeznalDemoCard searchQuery={query} task={task} archived={isClosed(state)} highlighted={task.id === highlightedId && Boolean(confirmedHighlight)} onOpen={opener => onOpen(task, opener)} titleButtonRef={button => titleButtonRef?.(task.id, button)} /> : <KanbanCardView searchQuery={query} task={task} onOpen={opener => onOpen(task, opener)} titleButtonRef={button => titleButtonRef?.(task.id, button)} />}</div>)}
            {!rows.length && <p className="request-board-empty">Здесь пока нет обращений</p>}
          </div>
        </section>;
      })}
    </div>}
  </div></TaskChangesProvider>;
}
