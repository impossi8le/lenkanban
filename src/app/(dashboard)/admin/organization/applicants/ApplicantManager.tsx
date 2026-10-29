"use client";
import {SearchHighlight} from "@/components/ui/SearchHighlight";

import * as React from "react";
import { useSession } from "next-auth/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { normalizeAdminSearch, resetAdminListQueries, uniqueById, useAdminPager } from "@/components/admin/admin-list";
import type { OrganizationApplicantPolicy, OrganizationProject, OrganizationProjectApplicants, OrganizationProjectPage, OrganizationMutation } from "@/lib/organization-contract";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

type Mode = "unconfigured" | "all" | "selected" | "none";
type Intent = { projectId: string; projectName: string | null; policy: OrganizationApplicantPolicy | null; expectedVersion: number };
type Command = { intent: Intent; operationId: string; actionId: string };
const prefix = "adminApplicants", base = "/api/admin/organization/projects", wrap = "h-auto min-h-11 max-w-full whitespace-normal break-all";
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
function status(error: unknown): number | undefined { try { return error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : undefined; } catch { return undefined; } }
function denied(error: unknown) { return status(error) === 401 || status(error) === 403; }
function modeOf(policy: OrganizationApplicantPolicy | null): Mode { return !policy ? "unconfigured" : policy.allEmployees ? "all" : policy.userIds.length || policy.departmentIds.length || policy.groupIds.length ? "selected" : "none"; }
function parseIds(value: string): string[] { const ids = value.trim() ? value.trim().split(/[\s,;]+/) : []; if (ids.length > 20 || ids.some(id => !idPattern.test(id))) throw new Error("INVALID_IDS"); return [...new Set(ids)].sort(); }
function draftPolicy(mode: Mode, users: string, departments: string, groups: string): OrganizationApplicantPolicy | null {
  if (mode === "unconfigured") return null;
  return { allEmployees: mode === "all", userIds: mode === "selected" ? parseIds(users) : [], departmentIds: mode === "selected" ? parseIds(departments) : [], groupIds: mode === "selected" ? parseIds(groups) : [] };
}
const modeNames: Record<Mode, string> = { unconfigured: "Не настроено", all: "Все пользователи системы", selected: "Выбранные субъекты", none: "Никто" };
const reasons = { unconfigured: "Политика не настроена", all_employees: "Все пользователи системы", explicit_user: "Пользователь указан явно", primary_department: "Основное активное подразделение", responsible_group: "Участие в активной группе", not_in_policy: "Совпадений с политикой нет" };

export default function ApplicantManager({ actorId }: { actorId: string }) {
  const { data: session, status: sessionStatus } = useSession();
  const client = useQueryClient();
  const [accessLost, setAccessLost] = React.useState(false);
  const matching = sessionStatus === "authenticated" && session?.user?.id === actorId && session.user.globalRole === "ADMIN";
  React.useEffect(() => {
    if (accessLost || (sessionStatus !== "loading" && !matching)) { void client.cancelQueries({ queryKey: [prefix, actorId] }); resetAdminListQueries(client, [prefix, actorId]); }
    return () => { void client.cancelQueries({ queryKey: [prefix, actorId] }); resetAdminListQueries(client, [prefix, actorId]); };
  }, [actorId, client, accessLost, matching, sessionStatus]);
  if (sessionStatus === "loading") return <p role="status" className="p-4">Проверка учётной записи…</p>;
  if (!matching || accessLost) return <div role="alert" className="space-y-3 p-4"><p>Учётная запись или права изменились. Политики заявителей скрыты.</p><Button className={wrap} onClick={() => window.location.reload()}>Обновить страницу</Button></div>;
  return <Browser key={actorId} actorId={actorId} onDenied={() => setAccessLost(true)} />;
}

function Browser({ actorId, onDenied }: { actorId: string; onDenied: () => void }) {
  const client = useQueryClient();
  const [search, setSearch] = React.useState(""), [q, setQ] = React.useState(""), [epoch, setEpoch] = React.useState(0);
  const [projectId, setProjectId] = React.useState<string | null>(null), [previewInput, setPreviewInput] = React.useState(""), [previewId, setPreviewId] = React.useState("");
  const [mode, setMode] = React.useState<Mode>("unconfigured"), [users, setUsers] = React.useState(""), [departments, setDepartments] = React.useState(""), [groups, setGroups] = React.useState(""), [dirty, setDirty] = React.useState(false);
  const [validation, setValidation] = React.useState(""), [notice, setNotice] = React.useState("");
  const [draftVersion, setDraftVersion] = React.useState<number | undefined>(undefined);
  const [intent, setIntent] = React.useState<Intent | null>(null), [command, setCommand] = React.useState<Command | null>(null), [pending, setPending] = React.useState(false), [failure, setFailure] = React.useState<"unknown" | "conflict" | "rejected" | null>(null);
  const busy = React.useRef(false), scope = React.useRef(0), restoreFocus = React.useRef(false);
  const listRef = React.useRef<HTMLDivElement>(null), panelRef = React.useRef<HTMLDivElement>(null), moreRef = React.useRef<HTMLButtonElement>(null), triggerRef = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => () => { scope.current++; }, []);
  const projects = useAdminPager<OrganizationProject, OrganizationProjectPage>({ key: [prefix, actorId, "projects", q, epoch], url: base, params: q ? { q } : {} });
  const config = useQuery({ queryKey: [prefix, actorId, "policy", projectId, previewId, epoch], enabled: !!projectId, retry: false,
    queryFn: ({ signal }) => apiFetch<OrganizationProjectApplicants>(`${base}/${encodeURIComponent(projectId!)}/applicants${previewId ? `?userId=${encodeURIComponent(previewId)}` : ""}`, { signal }) });
  const forbidden = denied(projects.error) || denied(config.error);
  React.useEffect(() => { if (forbidden) onDenied(); }, [forbidden, onDenied]);
  React.useEffect(() => { if (config.data && !dirty) { const policy = config.data.policy; setMode(modeOf(policy)); setUsers(policy?.userIds.join("\n") ?? ""); setDepartments(policy?.departmentIds.join("\n") ?? ""); setGroups(policy?.groupIds.join("\n") ?? ""); setDraftVersion(config.data.version); } }, [config.data, dirty]);
  const version = projects.data?.pages[0]?.version;
  const mismatch = status(projects.error) === 409 || status(config.error) === 409 || !!projects.data?.pages.some(page => page.version !== version) || !!config.data && config.data.version !== version;
  const fetching = projects.isFetching || config.isFetching, locked = pending || failure === "unknown", blocked = locked || failure === "conflict";
  const staleDraft = dirty && draftVersion !== config.data?.version;
  const ready = !forbidden && !mismatch && !staleDraft && !blocked && Number.isSafeInteger(version) && !!projects.data && !!config.data && !fetching && !projects.isError && !config.isError;
  const rows = uniqueById(projects.data?.pages.flatMap(page => page.items) ?? []);
  const staleIntent = !!intent && intent.expectedVersion !== version;
  React.useEffect(() => { if (restoreFocus.current && projects.data && !fetching && !mismatch && !forbidden) { restoreFocus.current = false; listRef.current?.focus(); } }, [projects.data, fetching, mismatch, forbidden]);
  function clearIntent() { setIntent(null); setCommand(null); setFailure(null); setValidation(""); }
  function reload() { if (busy.current) return; restoreFocus.current = true; resetAdminListQueries(client, [prefix, actorId]); clearIntent(); setDirty(false); setEpoch(value => value + 1); }
  function select(id: string) { if (blocked || busy.current) return; setProjectId(id); setPreviewId(""); setPreviewInput(""); setDirty(false); clearIntent(); setNotice(""); }
  function searchProjects(value: string) { if (blocked || busy.current) return; resetAdminListQueries(client, [prefix, actorId]); setQ(normalizeAdminSearch(value)); setEpoch(value => value + 1); setProjectId(null); setPreviewId(""); setPreviewInput(""); setDirty(false); clearIntent(); }
  function edit(change: () => void) { if (blocked || busy.current) return; change(); setDirty(true); clearIntent(); }
  function open() {
    if (!ready || !config.data || version === undefined) return;
    let policy: OrganizationApplicantPolicy | null; try { policy = draftPolicy(mode, users, departments, groups); } catch { setValidation("В каждом поле допускается до 20 ID: латинские буквы, цифры, дефис и подчёркивание, длина до 128. Разделяйте ID пробелом, запятой или новой строкой."); return; }
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setIntent({ projectId: config.data.project.id, projectName: config.data.project.displayName, policy, expectedVersion: version }); setCommand(null); setFailure(null); setValidation(""); setNotice(""); setTimeout(() => panelRef.current?.focus(), 0);
  }
  function close() { if (blocked || busy.current) return; clearIntent(); triggerRef.current?.focus(); }
  async function execute(next: Command) {
    if (busy.current) return;
    busy.current = true; setPending(true); setCommand(next); setFailure(null); const requestScope = scope.current;
    try {
      const result = await apiFetch<OrganizationMutation<unknown>>(`${base}/${encodeURIComponent(next.intent.projectId)}/applicants`, { method: "PATCH", headers: { "Content-Type": "application/json", "X-Action-Id": next.actionId }, body: JSON.stringify({ policy: next.intent.policy, expectedVersion: next.intent.expectedVersion, operationId: next.operationId }) });
      if (requestScope !== scope.current) return;
      setIntent(null); setCommand(null); setDirty(false); setNotice(result.replayed ? "Ранее сохранённая операция подтверждена. Обновляем данные." : "Политика сохранена. Обновляем данные.");
      try { await client.invalidateQueries({ queryKey: [prefix, actorId] }); if (requestScope === scope.current) setNotice("Изменение подтверждено. Проверьте сохранённую политику ниже."); }
      catch { if (requestScope === scope.current) setNotice("Изменение сохранено, но перечитать данные не удалось. Обновите данные."); }
      if (requestScope === scope.current) listRef.current?.focus();
    } catch (error) { if (requestScope !== scope.current) return; if (denied(error)) { onDenied(); return; } const code = status(error); setFailure(code === 409 ? "conflict" : code === undefined || code >= 500 ? "unknown" : "rejected"); }
    finally { if (requestScope === scope.current) { busy.current = false; setPending(false); } }
  }
  function confirm(event: React.FormEvent) { event.preventDefault(); if (!ready || !intent || staleIntent || busy.current) return; try { void execute({ intent, operationId: crypto.randomUUID(), actionId: crypto.randomUUID() }); } catch { setNotice("Не удалось подготовить операцию. Обновите страницу."); } }
  async function load(retry = false) { if (projects.isFetching || blocked) return; const result = retry && !projects.isFetchNextPageError ? await projects.refetch() : await projects.fetchNextPage({ cancelRefetch: false }); if (!result.isError) setTimeout(() => { if (!moreRef.current?.disabled) moreRef.current?.focus(); if (moreRef.current?.disabled || document.activeElement !== moreRef.current) listRef.current?.focus(); }, 0); }
  function preview(event: React.FormEvent) { event.preventDefault(); if (blocked || busy.current) return; const value = previewInput.trim(); if (!idPattern.test(value)) { setValidation("Для проверки укажите один корректный ID пользователя."); return; } setValidation(""); if (value === previewId) void config.refetch(); else setPreviewId(value); }
  if (forbidden) return null;
  return <div className="min-w-0 space-y-4 p-4 sm:p-6">
    <h1 className="text-xl font-bold break-words sm:text-2xl">Круг заявителей доски</h1><p>Предварительная проверка будущей подачи; действующий доступ к доске не изменён.</p><p className="text-sm text-muted-foreground">«Все» означает любого существующего пользователя системы. Подразделение учитывается только основное и активное, без наследования; группы проверяются независимо. Новая настройка пока не применяется к созданию задач.</p>
    <Button className={wrap} variant="outline" disabled={locked || fetching} onClick={reload}>Обновить все данные</Button>{notice && <p role="status">{notice}</p>}{validation && <p role="alert">{validation}</p>}
    {mismatch ? <div role="alert" className="space-y-2"><p>Версии данных различаются или политика требует проверки. Данные скрыты до обновления.</p><Button className={wrap} disabled={locked || fetching} onClick={reload}>Загрузить актуальные данные</Button></div> : <fieldset aria-label="Настройка заявителей" disabled={blocked} className="min-w-0 space-y-4">
      <Card><CardHeader><CardTitle>Доски</CardTitle><form className="flex min-w-0 flex-wrap gap-2" onSubmit={event => { event.preventDefault(); searchProjects(search); }}><label className="grid w-full min-w-0 basis-full gap-1 text-sm sm:w-auto sm:basis-0 sm:flex-1">Название или ID доски<Input className="w-full min-w-0" maxLength={128} value={search} onChange={event => setSearch(event.target.value)} /></label><Button className={wrap} type="submit" variant="outline">Найти</Button><Button className={wrap} type="button" variant="outline" onClick={() => { setSearch(""); searchProjects(""); }}>Сбросить поиск</Button></form></CardHeader><CardContent className="min-w-0 space-y-3">
        {projects.isPending && <p role="status">Загрузка досок…</p>}{projects.isError && <div role="alert"><p>Не удалось загрузить доски. Ранее загруженные строки сохранены, если они были.</p><Button className={wrap} disabled={projects.isFetching || blocked} onClick={() => void load(true)}>Повторить загрузку досок</Button></div>}
        {projects.data && <><div ref={listRef} tabIndex={-1} aria-label="Доски" className="max-w-full overflow-x-auto rounded-md border"><ul>{rows.map(row => <li key={row.id} className="min-w-0 space-y-2 border-b p-3"><p className="break-all font-medium"><SearchHighlight text={row.displayName ?? "Без названия"} query={q}/></p><p className="break-all text-xs">ID: <SearchHighlight text={row.id} query={q}/></p><Button className={wrap} variant="outline" aria-pressed={projectId === row.id} onClick={() => select(row.id)}><span className="block min-w-0 max-w-full break-all">Выбрать доску {row.id}</span></Button></li>)}</ul>{rows.length === 0 && !projects.isError && <p className="p-3">Ничего не найдено.</p>}</div><Button ref={moreRef} className={wrap} variant="outline" disabled={!projects.hasNextPage || projects.isFetching || blocked} onClick={() => void load()}>{projects.isFetchingNextPage ? "Загрузка…" : projects.hasNextPage ? "Загрузить ещё" : "Всё загружено"}</Button></>}
      </CardContent></Card>
      {projectId && <Card><CardHeader><CardTitle>Политика и проверка</CardTitle></CardHeader><CardContent className="min-w-0 space-y-4">
        {config.isPending && <p role="status">Загрузка политики…</p>}{config.isError && <div role="alert"><p>Не удалось загрузить сохранённую политику или проверить пользователя. Ранее полученные данные не являются результатом новой проверки.</p><Button className={wrap} disabled={config.isFetching || blocked} onClick={() => void config.refetch()}>Повторить загрузку политики</Button></div>}
        {config.data && <><section aria-label="Сохранённая политика" className="min-w-0 space-y-2"><h2 className="font-semibold">Сохранённая политика</h2><p className="break-all">Доска: {config.data.project.displayName ?? "Без названия"} · {config.data.project.id}</p><Policy policy={config.data.policy} /><p>Версия сохранённых данных: {config.data.version}</p></section>
          <div className="min-w-0 space-y-3"><h2 className="font-semibold">Редактор политики</h2><p>{dirty ? "Есть несохранённые изменения. Проверка ниже использует только сохранённую политику." : "Редактор показывает загруженную политику. Изменения требуют подтверждения."}</p>{staleDraft && <p role="alert">Сохранённая политика изменилась после начала редактирования. Обновите все данные и задайте настройку заново; старый черновик не будет перенесён на новую версию.</p>}<label className="grid min-w-0 gap-1">Режим<select className="min-w-0 max-w-full rounded-md border bg-background p-2" value={mode} onChange={event => edit(() => setMode(event.target.value as Mode))}>{Object.entries(modeNames).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>
          {mode === "selected" && <div className="grid min-w-0 gap-3">{([["ID пользователей", users, setUsers], ["ID подразделений", departments, setDepartments], ["ID групп", groups, setGroups]] as const).map(([label, value, setter]) => <label key={label} className="grid min-w-0 gap-1 text-sm">{label}<textarea className="min-h-24 w-full min-w-0 rounded-md border bg-background p-2" maxLength={2600} value={value} onChange={event => edit(() => setter(event.target.value))} /></label>)}<p className="text-sm">До 20 ID в каждом поле. Разделитель — пробел, запятая или новая строка. Совпадения складываются по правилу «или».</p></div>}
          <Button className={wrap} disabled={!ready} onClick={open}>Проверить и подтвердить настройку</Button></div>
          <form className="flex min-w-0 flex-wrap gap-2" onSubmit={preview}><label className="grid w-full min-w-0 basis-full gap-1 text-sm sm:w-auto sm:basis-0 sm:flex-1">ID пользователя для предварительной проверки<Input className="w-full min-w-0" maxLength={128} value={previewInput} onChange={event => setPreviewInput(event.target.value)} /></label><Button className={wrap} type="submit" variant="outline" disabled={fetching}>Проверить сохранённую политику</Button></form>
          {config.data.preview && <section aria-label="Предварительная проверка" className="min-w-0 space-y-2"><p className="break-all">Пользователь: {config.data.preview.userId}</p><p>Будущая подача: {config.data.preview.allowed === null ? "не определена" : config.data.preview.allowed ? "разрешена предварительной политикой" : "не входит в выбранный круг"}</p><p>Причина: {reasons[config.data.preview.source]}</p><p>Версия проверки: {config.data.version}</p></section>}
        </>}
      </CardContent></Card>}
    </fieldset>}
    {intent && <div ref={panelRef} tabIndex={-1} role="region" aria-label="Подтверждение круга заявителей" className="min-w-0 space-y-3 rounded-md border p-3"><h2 className="font-semibold">Итоговая настройка</h2><p className="break-all">Доска: {intent.projectName ?? "Без названия"} · {intent.projectId}</p><Policy policy={intent.policy} /><p>Версия подтверждения: {intent.expectedVersion}</p>{staleIntent && failure !== "unknown" && <p role="alert">Данные изменились после открытия подтверждения. Обновите данные или закройте форму и задайте действие заново.</p>}{failure === "unknown" && <p role="alert">Результат неизвестен. Повтор отправит ту же политику и исходную версию.</p>}{failure === "conflict" && <p role="alert">Конфликт версии или ограничений. Новые действия заблокированы до явного обновления данных.</p>}{failure === "rejected" && <p role="alert">Изменение отклонено. Проверьте ID и состояние выбранных субъектов.</p>}<form onSubmit={confirm} className="flex flex-wrap gap-2">{failure === "unknown" ? <><Button className={wrap} type="button" disabled={pending} onClick={() => { if (command) void execute(command); }}>Повторить ту же операцию</Button><Button className={wrap} type="button" variant="outline" disabled={pending} onClick={reload}>Обновить без повтора</Button></> : failure === "conflict" ? <Button className={wrap} type="button" disabled={pending || fetching} onClick={reload}>Обновить после конфликта</Button> : <Button className={wrap} type="submit" disabled={!ready || staleIntent}>{pending ? "Сохранение…" : "Подтвердить"}</Button>}<Button className={wrap} type="button" variant="outline" disabled={blocked} onClick={close}>Закрыть</Button></form></div>}
  </div>;
}

function Policy({ policy }: { policy: OrganizationApplicantPolicy | null }) {
  return <div className="min-w-0 space-y-1"><p>Круг заявителей: {modeNames[modeOf(policy)]}</p>{policy && !policy.allEmployees && <><p className="break-all">Пользователи (ID): {policy.userIds.join(", ") || "нет"}</p><p className="break-all">Подразделения (ID): {policy.departmentIds.join(", ") || "нет"}</p><p className="break-all">Группы (ID): {policy.groupIds.join(", ") || "нет"}</p></>}</div>;
}
