"use client";

import * as React from "react";
import { problemReportReasonLabel, problemReportScreenLabel } from "@/components/diagnostics/problem-report-labels";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { TelemetryCategory, TelemetryErrorDetail, TelemetryEventsPage, TelemetryReportEvent, TelemetryReportFilters, TelemetrySummary } from "@/lib/telemetry/report-contract";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";

type Filters = Required<Pick<TelemetryReportFilters, "from" | "to">> & Pick<TelemetryReportFilters, "projectId" | "revision">;
const reportKey = "adminTelemetryReport";
const idPattern = /^[a-zA-Z0-9_-]{1,128}$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function safeId(value?: string | null) { return value && idPattern.test(value) ? value : "—"; }
function date(value: string | null) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return "—";
  return new Date(value).toLocaleString("ru-RU", { timeZone: "UTC" }) + " UTC";
}
function queryString(filters: TelemetryReportFilters) {
  const params = new URLSearchParams();
  for (const key of ["from", "to", "projectId", "revision"] as const) if (filters[key]) params.set(key, filters[key]);
  return params;
}
function windowFor(serverNow: string, hours: number, projectId = "", revision = ""): Filters {
  return { from: new Date(new Date(serverNow).getTime() - hours * 3600000).toISOString(), to: serverNow,
    ...(projectId.trim() ? { projectId: projectId.trim() } : {}), ...(revision.trim() ? { revision: revision.trim() } : {}) };
}

export default function TelemetryDashboard({ serverNow }: { serverNow: string }) {
  const client = useQueryClient();
  const [hours, setHours] = React.useState("24");
  const [project, setProject] = React.useState("");
  const [revision, setRevision] = React.useState("");
  const [filters, setFilters] = React.useState<Filters>(() => windowFor(serverNow, 24));
  const [generation, setGeneration] = React.useState(0);
  function apply(next: Filters) {
    // Revisiting a previous filter starts at its first page, including cached searches.
    client.removeQueries({ queryKey: [reportKey] });
    setFilters(next);
    setGeneration(value => value + 1);
  }
  return <div className="min-w-0 space-y-4 p-4 sm:p-6">
    <h1 className="text-2xl font-bold break-words">Телеметрия</h1>
    <p className="text-sm text-muted-foreground">Наблюдаем только переключение пунктов чек-листа и ошибки отображения приложения. Эти данные не оценивают производительность сотрудников. Подробности доступны глобальным администраторам, срок хранения — 30 дней.</p>
    <form className="flex min-w-0 flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); apply(windowFor(serverNow, Number(hours), project, revision)); }}>
      <label className="grid w-full sm:w-auto gap-1 text-sm">Период, UTC<select className="h-10 rounded-md border bg-background px-3" value={hours} onChange={event => setHours(event.target.value)}><option value="24">24 часа</option><option value="168">7 дней</option><option value="720">30 дней</option></select></label>
      <label className="grid w-full sm:w-auto min-w-0 gap-1 text-sm">ID проекта<Input className="w-full sm:w-52" value={project} maxLength={128} pattern={"[a-zA-Z0-9_\\-]*"} onChange={event => setProject(event.target.value)} /></label>
      <label className="grid w-full sm:w-auto min-w-0 gap-1 text-sm">Ревизия (SHA)<Input className="w-full sm:w-52" value={revision} maxLength={64} pattern="[a-fA-F0-9]{7,64}" onChange={event => setRevision(event.target.value)} /></label>
      <div className="flex w-full sm:w-auto gap-2">
        <Button className="flex-1 sm:flex-none" type="submit">Применить</Button>
        <Button className="flex-1 sm:flex-none" type="button" variant="outline" onClick={() => { setHours("24"); setProject(""); setRevision(""); apply(windowFor(serverNow, 24)); }}>Сбросить</Button>
      </div>
    </form>
    {(filters.projectId || filters.revision) && <p role="status" className="text-sm text-muted-foreground">Фильтры учитывают только события с записанными projectId/revision. Клиентские события и часть подтверждённых изменений не несут эти поля, поэтому нулевые показатели не доказывают отсутствие использования.</p>}
    <Report key={generation} filters={filters} />
  </div>;
}

function ErrorNotice({ retry, pending, children }: { retry: () => void; pending: boolean; children: React.ReactNode }) {
  return <div role="alert" className="space-y-2 rounded-md border border-destructive p-3 text-sm"><p>{children}</p><Button type="button" variant="outline" disabled={pending} onClick={retry}>Повторить</Button></div>;
}
function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="min-w-0 rounded-md border p-3"><dt className="text-sm text-muted-foreground">{label}</dt><dd className="mt-1 text-xl font-semibold">{value}</dd></div>;
}
function Report({ filters }: { filters: Filters }) {
  const [category, setCategory] = React.useState<TelemetryCategory>("diagnostic");
  const [selectedError, setSelectedError] = React.useState<string | null>(null);
  const errorTrigger = React.useRef<HTMLElement | null>(null);
  const client = useQueryClient();
  const summary = useQuery({ queryKey: [reportKey, "summary", filters], queryFn: ({ signal }) => apiFetch<TelemetrySummary>(`/api/admin/telemetry/summary?${queryString(filters)}`, { signal }), retry: false });
  const data = summary.data;
  const available = data?.collection.state === "available";
  const anchored = data ? { ...filters, from: data.window.from, to: data.window.to } : filters;
  return <div className="min-w-0 space-y-4" aria-busy={summary.isFetching}>
    {summary.isPending && <p role="status">Загрузка сводки…</p>}
    {summary.isError && <ErrorNotice pending={summary.isFetching} retry={() => void summary.refetch()}>Не удалось загрузить сводку. {data ? "Показаны ранее загруженные данные." : "Состояние сбора неизвестно."}</ErrorNotice>}
    {data && <>
      <p className="text-sm">Период: {date(data.window.from)} — {date(data.window.to)} (правая граница не включена).</p>
      {data.collection.state === "disabled" && <p role="status">Сбор телеметрии выключен.</p>}
      {data.collection.state === "unconfigured" && <p role="status">Сбор телеметрии не настроен.</p>}
      {available && <>
        <p className="text-sm">Сбор доступен. Просмотрено строк: {data.collection.observedRows} из лимита {data.collection.limit}. Последнее получение: {date(data.collection.latestReceivedAt)}.</p>
        {data.collection.truncated && <p role="status" className="text-sm text-destructive">Выборка ограничена: показатели неполные; доля серверных ошибок не рассчитывается.</p>}
        {data.collection.observedRows === 0 && <p role="status">За выбранный период событий нет.</p>}
        {(!data.collection.latestReceivedAt || new Date(data.window.to).getTime() - new Date(data.collection.latestReceivedAt).getTime() > 3600000) && <p className="text-sm text-muted-foreground">Есть промежуток без полученных событий. Это не подтверждает сбой сборщика.</p>}
      </>}
      <section aria-labelledby="diagnostics-heading"><Card><CardHeader><h2 id="diagnostics-heading" className="text-2xl font-semibold leading-none tracking-tight">Ошибки и состояние системы</h2><CardDescription>Серверные наблюдения отделены от сообщений клиента. Здоровье сборщика, потери, повторы доставки и задержки доставки — не измеряются.</CardDescription></CardHeader><CardContent className="space-y-3">
        {available ? <>
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Metric label="Серверные запросы" value={data.diagnostics.requestCount} /><Metric label="Серверные ответы 5xx" value={data.diagnostics.failedRequestCount} />
            <Metric label="Доля 5xx среди серверных запросов" value={data.collection.truncated || data.diagnostics.requestCount === 0 || data.diagnostics.failureRate === null ? "Не рассчитывается" : `${(data.diagnostics.failureRate * 100).toFixed(1)}%`} />
            <Metric label="Отклонённые серверные запросы" value={data.diagnostics.rejectedRequestCount} /><Metric label="Конфликты серверных запросов" value={data.diagnostics.conflictRequestCount} />
            <Metric label="Ошибки запросов по сообщениям клиента" value={data.diagnostics.clientFailures} /><Metric label="Отмены по сообщениям клиента" value={data.diagnostics.clientCancellations} /><Metric label="Ошибки отображения по сообщениям клиента" value={data.diagnostics.renderFailures} />
          </dl>
          {data.diagnostics.requestCount < 10 && <p className="text-sm">Недостаточная выборка: менее 10 серверных запросов.</p>}
        </> : <p>Показатели недоступны при выключенном или ненастроенном сборе.</p>}
      </CardContent></Card></section>
      {available && data.requestLatency && <RequestLatency data={data} />}
      <section aria-labelledby="usage-heading"><Card><CardHeader><h2 id="usage-heading" className="text-2xl font-semibold leading-none tracking-tight">Использование функций</h2><CardDescription>Использование: только переключение чек-листа (task.checklist.toggle). Для app.render собираются только ошибки отображения. Серверная диагностика охватывает чек-лист и повторяющиеся задачи. Остальные функции не измеряются.</CardDescription></CardHeader><CardContent>
        {available ? <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2"><Metric label="Уникальные намерения (actor + actionId)" value={data.usage.uniqueActions} /><Metric label="Клиентские сессии (actor + sessionId)" value={data.usage.clientSessions} /><Metric label="Клиентские псевдонимы" value={data.usage.clientActors} /><Metric label="Подтверждённые изменения (серверные операции)" value={data.usage.committedChanges} /></dl> : <p>Показатели недоступны при выключенном или ненастроенном сборе.</p>}
      </CardContent></Card></section>
      {available && <Card><CardHeader><h2 className="text-2xl font-semibold leading-none tracking-tight">События</h2><label className="grid max-w-xs gap-1 text-sm">Раздел<select value={category} className="h-10 rounded-md border bg-background px-3" onChange={event => { const next = event.target.value as TelemetryCategory; client.removeQueries({ queryKey: [reportKey, "events", anchored, next], exact: true }); setSelectedError(null); setCategory(next); }}><option value="diagnostic">Ошибки и состояние системы</option><option value="usage">Использование функций</option></select></label></CardHeader><CardContent className="min-w-0 space-y-4"><Events key={category} filters={anchored} category={category} onError={id => { errorTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setSelectedError(id); }} />{selectedError && <ErrorDetail key={selectedError} errorId={selectedError} filters={anchored} onClose={() => { setSelectedError(null); errorTrigger.current?.focus(); }} />}</CardContent></Card>}
    </>}
  </div>;
}

function RequestLatency({ data }: { data: TelemetrySummary }) {
  const latency = data.requestLatency;
  if (!latency) return null;
  const duration = (value: number) => Number.isFinite(value) && value >= 0 ? `${Math.round(value)} мс` : "—";
  return <section aria-labelledby="request-latency-heading"><Card><CardHeader><h2 id="request-latency-heading" className="text-2xl font-semibold leading-none tracking-tight">Время запросов</h2><CardDescription>Частичная сохранённая выборка за выбранный период; это не статистика всех HTTP-запросов. Наблюдение клиента и время серверного обработчика измеряют разные этапы и показаны отдельно.</CardDescription></CardHeader><CardContent className="min-w-0 space-y-3">
    <p className="text-sm">Окно: {date(data.window.from)} — {date(data.window.to)}. Просмотрено строк: {data.collection.observedRows} из лимита {data.collection.limit}. Перцентили: ближайший ранг (nearest rank). Медленные: от {latency.slowThresholdMs} мс.</p>
    {data.collection.truncated && <p role="status" className="text-sm text-destructive">Выборка времени запросов ограничена лимитом; перцентили относятся только к сохранённым наблюдениям в этой выборке.</p>}
    <p className="text-sm text-muted-foreground">Клиент: сохранённое наблюдение запроса из браузера. Сервер: обработчик маршрута с сохранённой диагностикой. Полный журнал HTTP и внешние метрики сюда не входят.</p>
    {latency.groups.length === 0 ? <p>Сохранённых наблюдений времени запросов за этот период нет.</p> : <div className="max-w-full overflow-x-auto rounded-md border"><table aria-label="Задержки запросов по маршрутам и источникам" className="w-full min-w-[760px] text-left text-sm"><thead><tr className="border-b">{["Маршрут", "Источник", "Наблюдений", "p50", "p95", "p99", "Максимум", "Медленных"].map(label => <th scope="col" key={label} className="p-3">{label}</th>)}</tr></thead><tbody>{latency.groups.map(group => <tr key={`${group.source}:${group.route}`} className="border-b"><th scope="row" className="break-all p-3 font-normal">{group.route}</th><td className="p-3">{group.source === "server.handler" ? "Обработчик сервера" : "Наблюдение клиента (браузер)"}</td><td className="p-3">{group.count}</td><td className="p-3">{duration(group.p50Ms)}</td><td className="p-3">{duration(group.p95Ms)}</td><td className="p-3">{duration(group.p99Ms)}</td><td className="p-3">{duration(group.maxMs)}</td><td className="p-3">{group.slowCount}</td></tr>)}</tbody></table></div>}
  </CardContent></Card></section>;
}

function Events({ filters, category, onError }: { filters: Filters; category: TelemetryCategory; onError: (id: string) => void }) {
  const listRef = React.useRef<HTMLDivElement>(null);
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const events = useInfiniteQuery({ queryKey: [reportKey, "events", filters, category], initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => { const params = queryString(filters); params.set("category", category); params.set("limit", "50"); if (pageParam) params.set("cursor", pageParam); return apiFetch<TelemetryEventsPage>(`/api/admin/telemetry?${params}`, { signal }); },
    getNextPageParam: page => page.nextCursor ?? undefined, retry: false });
  const rows = React.useMemo(() => { const seen = new Set<string>(); return events.data?.pages.flatMap(page => page.items).filter(item => { if (seen.has(item.id)) return false; seen.add(item.id); return true; }) ?? []; }, [events.data]);
  async function load(retry = false) {
    if (events.isFetching) return;
    const result = retry && !events.isFetchNextPageError ? await events.refetch() : await events.fetchNextPage({ cancelRefetch: false });
    if (!result.isError) setTimeout(() => { if (!buttonRef.current?.disabled) buttonRef.current?.focus(); if (buttonRef.current?.disabled || document.activeElement !== buttonRef.current) listRef.current?.focus(); }, 0);
  }
  return <div className="min-w-0 space-y-3">
    {events.isPending && <p role="status">Загрузка событий…</p>}
    {events.isError && <ErrorNotice pending={events.isFetching} retry={() => void load(true)}>Не удалось загрузить события. {events.data ? "Ранее загруженные строки сохранены." : "Попробуйте ещё раз."}</ErrorNotice>}
    {events.data && <><div ref={listRef} tabIndex={-1} aria-label="Список событий" className="max-w-full overflow-x-auto rounded-md border"><table className="w-full min-w-[640px] text-left text-sm"><thead><tr className="border-b"><th className="p-3">Получено, UTC</th><th className="p-3">Событие</th><th className="p-3">Источник</th><th className="p-3">Статус</th><th className="p-3">Ошибка</th></tr></thead><tbody>{rows.map(row => <tr key={row.id} className="border-b"><td className="p-3">{date(row.receivedAt)}</td><td className="p-3">{eventLabel(row.event)}</td><td className="p-3">{trustLabel(row.trust)}</td><td className="p-3">{status(row)}</td><td className="p-3">{row.errorId && uuidPattern.test(row.errorId) ? <Button variant="link" className="h-auto break-all whitespace-normal p-0 text-left" onClick={() => onError(row.errorId!)}>{row.errorId}</Button> : "—"}</td></tr>)}</tbody></table></div>
      {rows.length === 0 && !events.isError && <p>События не найдены.</p>}
      <Button ref={buttonRef} variant="outline" disabled={events.isFetching || !events.hasNextPage} onClick={() => void load()}>{events.isFetchingNextPage ? "Загрузка…" : events.hasNextPage ? "Загрузить ещё" : "Всё загружено"}</Button>
    </>}
  </div>;
}
function eventLabel(value: string) { return ({ "ui.action": "Действие клиента", "client.request.result": "Результат запроса клиента", "client.render.failed": "Ошибка отображения", "client.problem.reported": "Сообщение сотрудника", "task.checklist.updated": "Изменён чек-лист", "api.request.completed": "Серверный запрос", "api.request.failed": "Ошибка серверного запроса" } as Record<string, string>)[value] ?? "Событие"; }
function trustLabel(value: TelemetryReportEvent["trust"]) { return value === "authoritative" ? "Подтверждено сервером" : value === "server_observed" ? "Наблюдение сервера" : "Сообщение клиента"; }
function status(row: TelemetryReportEvent) { const code = row.payload.statusCode; const outcome = ({ success: "Успех", failure: "Ошибка", rejected: "Отклонено", conflict: "Конфликт", cancelled: "Отменено" } as Record<string, string>)[row.payload.outcome ?? ""]; return [outcome, Number.isInteger(code) && code! >= 100 && code! <= 599 ? code : undefined].filter(value => value !== undefined && value !== "").join(" · ") || "—"; }
function ErrorDetail({ errorId, filters, onClose }: { errorId: string; filters: Filters; onClose: () => void }) {
  const panelRef = React.useRef<HTMLElement>(null);
  React.useEffect(() => { panelRef.current?.focus(); }, []);
  const detail = useQuery({ queryKey: [reportKey, "error", filters, errorId], queryFn: ({ signal }) => apiFetch<TelemetryErrorDetail>(`/api/admin/telemetry/errors/${encodeURIComponent(errorId)}?${queryString(filters)}`, { signal }), retry: false });
  return <section ref={panelRef} tabIndex={-1} aria-labelledby="error-detail-heading" className="min-w-0 space-y-3 rounded-md border p-3"><div className="flex flex-wrap items-center justify-between gap-2"><h3 id="error-detail-heading" className="font-semibold">Подробности ошибки</h3><Button variant="outline" onClick={onClose}>Закрыть</Button></div><p className="break-all text-sm">Error ID: {safeId(errorId)}</p>
    {detail.isPending && <p role="status">Загрузка подробностей…</p>}
    {detail.isError && <ErrorNotice pending={detail.isFetching} retry={() => void detail.refetch()}>Не удалось загрузить подробности. {detail.data ? "Показаны ранее загруженные данные." : "Событие могло выйти за срок хранения или фильтры."}</ErrorNotice>}
    {detail.data && <><p className="text-sm">Связь: {detail.data.linkage === "server_verified" ? "подтверждена сервером" : "заявлена клиентом; серверное подтверждение отсутствует"}.</p>{detail.data.problemReport && <div className="space-y-2 rounded-md border p-3" aria-label="Сообщение сотрудника"><h4 className="font-medium">Сообщение сотрудника</h4><p>Номер сообщения: <code>{safeId(detail.data.problemReport.reportId)}</code></p><p>{problemReportReasonLabel(detail.data.problemReport.reason)} · {problemReportScreenLabel(detail.data.problemReport.screen)}</p><p>Прикреплено технических действий: {detail.data.problemReport.breadcrumbCount}</p>{detail.data.problemReport.comment !== undefined && <section aria-label="Комментарий сотрудника" className="space-y-2"><h5 className="font-medium">Комментарий сотрудника</h5><p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{detail.data.problemReport.comment}</p></section>}<p className="text-sm text-muted-foreground">Описание проблемы заявлено сотрудником. Это не подтверждение серверной ошибки.</p></div>}{detail.data.truncated && <p role="status">Цепочка ограничена; показаны не все события.</p>}<h4 className="font-medium">{detail.data.problemReport ? "События сообщения" : "События ошибки"}</h4><Breadcrumbs rows={detail.data.events} /><h4 className="font-medium">Связанные действия по времени</h4><Breadcrumbs rows={detail.data.breadcrumbs} /></>}
  </section>;
}
function Breadcrumbs({ rows }: { rows: TelemetryReportEvent[] }) {
  const ordered = [...rows].sort((a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime() || (a.payload.seq ?? 0) - (b.payload.seq ?? 0) || a.id.localeCompare(b.id));
  return <ol className="space-y-2 text-sm">{ordered.map(row => <li key={row.id} className="min-w-0 space-y-1 rounded-md bg-muted p-3"><p>{date(row.occurredAt)} · {eventLabel(row.event)} · {trustLabel(row.trust)} · {status(row)}</p><p>{row.payload.action === "task.checklist.toggle" ? "Переключение чек-листа" : row.payload.action === "app.render" ? "Отображение приложения" : row.event === "client.problem.reported" ? problemReportReasonLabel(row.payload.reason) : row.payload.kind === "navigation" ? `Переход: ${problemReportScreenLabel(row.payload.name === "root" ? "home" : row.payload.name)}` : row.payload.kind === "request" ? "Сетевой запрос" : row.payload.kind === "dialog" ? "Открытие окна" : row.payload.kind === "connectivity" ? "Состояние соединения" : "Действие не указано"}</p>{typeof row.payload.durationMs === "number" && Number.isFinite(row.payload.durationMs) && row.payload.durationMs >= 0 && <p>Время: {Math.round(row.payload.durationMs)} мс</p>}<p className="break-all">Action ID: {safeId(row.actionId)} · Request ID: {safeId(row.requestId)} · Event ID: {safeId(row.eventId)} · Error ID: {safeId(row.errorId)}</p></li>)}{ordered.length === 0 && <li>Связанные события не найдены.</li>}</ol>;
}
