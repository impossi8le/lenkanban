"use client";
import {SearchHighlight} from "@/components/ui/SearchHighlight";

import * as React from "react";
import { useSession } from "next-auth/react";
import { useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import {
  AdminPagedList,
  normalizeAdminSearch,
  resetAdminListQueries,
  uniqueById,
  useAdminPager,
} from "@/components/admin/admin-list";
import type { OrganizationDepartment, OrganizationDepartmentPage, OrganizationGroup, OrganizationGroupPage, OrganizationMutation, OrganizationProject, OrganizationProjectPage } from "@/lib/organization-contract";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

type Intent = { projectId: string; projectName: string | null; departmentId: string | null; responsibleGroupId: string | null; expectedVersion: number };
type Command = { intent: Intent; operationId: string; actionId: string };
const prefix = "adminBindings", base = "/api/admin/organization";
const wrap = "h-auto min-h-11 max-w-full whitespace-normal break-all";
function status(error: unknown): number | undefined { try { return error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : undefined; } catch { return undefined; } }
function denied(error: unknown) { return status(error) === 401 || status(error) === 403; }

export default function BindingManager({ actorId }: { actorId: string }) {
  const { data: session, status: sessionStatus } = useSession();
  const client = useQueryClient();
  const [accessLost, setAccessLost] = React.useState(false);
  const matching = sessionStatus === "authenticated" && session?.user?.id === actorId && session.user.globalRole === "ADMIN";
  React.useEffect(() => {
    if (accessLost || (sessionStatus !== "loading" && !matching)) { void client.cancelQueries({ queryKey: [prefix, actorId] }); resetAdminListQueries(client, [prefix, actorId]); }
    return () => { void client.cancelQueries({ queryKey: [prefix, actorId] }); resetAdminListQueries(client, [prefix, actorId]); };
  }, [actorId, client, accessLost, matching, sessionStatus]);
  if (sessionStatus === "loading") return <p role="status" className="p-4">Проверка учётной записи…</p>;
  if (!matching || accessLost) return <div role="alert" className="space-y-3 p-4"><p>Учётная запись или права изменились. Данные привязок скрыты.</p><Button className={wrap} onClick={() => window.location.reload()}>Обновить страницу</Button></div>;
  return <Browser key={actorId} actorId={actorId} onDenied={() => setAccessLost(true)} />;
}

function Browser({ actorId, onDenied }: { actorId: string; onDenied: () => void }) {
  const client = useQueryClient();
  const [search, setSearch] = React.useState(""), [q, setQ] = React.useState("");
  const [trail, setTrail] = React.useState<{ id: string; name: string }[]>([]);
  const [archive, setArchive] = React.useState("all");
  const [epoch, setEpoch] = React.useState(0), [searchEpoch, setSearchEpoch] = React.useState(0);
  const [projectId, setProjectId] = React.useState<string | null>(null), [departmentId, setDepartmentId] = React.useState<string | null>(null), [groupId, setGroupId] = React.useState<string | null>(null);
  const [intent, setIntent] = React.useState<Intent | null>(null), [command, setCommand] = React.useState<Command | null>(null);
  const [pending, setPending] = React.useState(false), [failure, setFailure] = React.useState<"unknown" | "conflict" | "rejected" | null>(null);
  const [notice, setNotice] = React.useState("");
  const busy = React.useRef(false), scope = React.useRef(0), restoreFocus = React.useRef(false);
  const projectsRef = React.useRef<HTMLDivElement>(null), panelRef = React.useRef<HTMLDivElement>(null), triggerRef = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => () => { scope.current++; }, []);
  const parentId = trail.at(-1)?.id;
  const projects = useAdminPager<OrganizationProject, OrganizationProjectPage>({ key: [prefix, actorId, "projects", q, epoch, searchEpoch], url: `${base}/projects`, params: q ? { q } : {} });
  const departments = useAdminPager<OrganizationDepartment, OrganizationDepartmentPage>({ key: [prefix, actorId, "departments", parentId, epoch], url: `${base}/departments`, params: { archived: "all", ...(parentId ? { parentId } : {}) } });
  const groups = useAdminPager<OrganizationGroup, OrganizationGroupPage>({ key: [prefix, actorId, "groups", archive, epoch], url: `${base}/groups`, params: { archived: archive } });
  const queries = [projects, departments, groups];
  const forbidden = queries.some(query => denied(query.error));
  React.useEffect(() => { if (forbidden) onDenied(); }, [forbidden, onDenied]);
  const version = projects.data?.pages[0]?.version;
  const mismatch = queries.some(query => status(query.error) === 409 || query.data?.pages.some(page => page.version !== version));
  const fetching = queries.some(query => query.isFetching);
  const locked = pending || failure === "unknown";
  const blocked = locked || failure === "conflict";
  const ready = !forbidden && !mismatch && !blocked && Number.isSafeInteger(version) && queries.every(query => !!query.data && !query.isFetching && !query.isError);
  const projectRows = uniqueById(projects.data?.pages.flatMap(page => page.items) ?? []), departmentRows = uniqueById(departments.data?.pages.flatMap(page => page.items) ?? []), groupRows = uniqueById(groups.data?.pages.flatMap(page => page.items) ?? []);
  const project = projectRows.find(row => row.id === projectId), parent = departments.data?.pages[0]?.parent;
  const department = parent?.id === departmentId ? parent : departmentRows.find(row => row.id === departmentId), group = groupRows.find(row => row.id === groupId);
  const staleIntent = !!intent && intent.expectedVersion !== version;
  React.useEffect(() => { if (restoreFocus.current && projects.data && !fetching && !mismatch && !forbidden) { restoreFocus.current = false; projectsRef.current?.focus(); } }, [projects.data, fetching, mismatch, forbidden]);
  function reload() { if (busy.current) return; restoreFocus.current = true; resetAdminListQueries(client, [prefix, actorId]); setIntent(null); setCommand(null); setFailure(null); setEpoch(value => value + 1); }
  function select(kind: "project" | "department" | "group", id: string) { if (blocked || busy.current) return; if (kind === "project") setProjectId(id); else if (kind === "department") setDepartmentId(id); else setGroupId(id); setIntent(null); setCommand(null); setFailure(null); }
  function navigate(next: typeof trail) { if (blocked || busy.current) return; setTrail(next); setDepartmentId(null); reload(); }
  function searchProjects(value: string) { if (blocked || busy.current) return; resetAdminListQueries(client, [prefix, actorId, "projects"]); setQ(normalizeAdminSearch(value)); setSearchEpoch(number => number + 1); setProjectId(null); setIntent(null); setCommand(null); setFailure(null); }
  function open(action: "department" | "clearDepartment" | "group" | "clearGroup" | "clearBoth") {
    if (!ready || !project || version === undefined) return;
    if (action === "department" && (!department || department.archived)) return;
    if (action === "group" && (!group || group.archived)) return;
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setIntent({ projectId: project.id, projectName: project.displayName, expectedVersion: version,
      departmentId: action === "department" ? department!.id : action === "clearDepartment" || action === "clearBoth" ? null : project.departmentId,
      responsibleGroupId: action === "group" ? group!.id : action === "clearGroup" || action === "clearBoth" ? null : project.responsibleGroupId });
    setCommand(null); setFailure(null); setNotice(""); setTimeout(() => panelRef.current?.focus(), 0);
  }
  function close() { if (blocked || busy.current) return; setIntent(null); setCommand(null); setFailure(null); triggerRef.current?.focus(); }
  async function execute(next: Command) {
    if (busy.current) return;
    busy.current = true; setPending(true); setCommand(next); setFailure(null); const requestScope = scope.current;
    try {
      const { projectId: targetId, projectName: _name, ...body } = next.intent; void _name;
      const result = await apiFetch<OrganizationMutation<unknown>>(`${base}/projects/${encodeURIComponent(targetId)}`, { method: "PATCH", headers: { "Content-Type": "application/json", "X-Action-Id": next.actionId }, body: JSON.stringify({ ...body, operationId: next.operationId }) });
      if (requestScope !== scope.current) return;
      setIntent(null); setCommand(null); setNotice(result.replayed ? "Ранее сохранённая операция подтверждена. Обновляем данные." : "Изменение сохранено. Обновляем данные.");
      try { await client.invalidateQueries({ queryKey: [prefix, actorId] }); if (requestScope === scope.current) setNotice("Изменение подтверждено. Проверьте актуальные списки ниже."); }
      catch { if (requestScope === scope.current) setNotice("Изменение сохранено, но перечитать данные не удалось. Обновите списки."); }
      if (requestScope === scope.current) projectsRef.current?.focus();
    } catch (error) { if (requestScope !== scope.current) return; if (denied(error)) { onDenied(); return; } const code = status(error); setFailure(code === 409 ? "conflict" : code === undefined || code >= 500 ? "unknown" : "rejected"); }
    finally { if (requestScope === scope.current) { busy.current = false; setPending(false); } }
  }
  function confirm(event: React.FormEvent) { event.preventDefault(); if (!ready || !intent || staleIntent || busy.current) return; try { const operationId = crypto.randomUUID(), actionId = crypto.randomUUID(); void execute({ intent, operationId, actionId }); } catch { setNotice("Не удалось подготовить операцию. Обновите страницу."); } }
  if (forbidden) return null;
  return <div className="min-w-0 space-y-4 p-4 sm:p-6">
    <h1 className="text-xl font-bold break-words sm:text-2xl">Привязки досок</h1><p className="text-sm text-muted-foreground">Организационные связи не изменяют права владельцев и участников досок. Подразделение и группа независимы. Связь с архивным подразделением или группой может быть отклонена сервером: исправьте или снимите её.</p>
    <p className="text-sm text-muted-foreground">Актуальные данные перечитываются после изменений. Название или существование доски могут измениться отдельно; при сохранении сервер проверяет доску заново.</p>
    <Button className={wrap} variant="outline" disabled={locked || fetching} onClick={reload}>Обновить все данные</Button>{notice && <p role="status">{notice}</p>}
    {mismatch ? <div role="alert" className="space-y-2"><p>Версии списков различаются или снимок устарел. Данные скрыты до обновления.</p><Button className={wrap} disabled={locked || fetching} onClick={reload}>Загрузить актуальные списки</Button></div> : <fieldset aria-label="Выбор привязок" disabled={blocked} className="min-w-0 space-y-4">
      <Card><CardHeader><CardTitle>Доски</CardTitle><form className="flex min-w-0 flex-wrap gap-2" onSubmit={event => { event.preventDefault(); searchProjects(search); }}><label className="grid w-full min-w-0 basis-full gap-1 text-sm sm:w-auto sm:basis-0 sm:flex-1">Название или ID доски<Input className="w-full min-w-0" maxLength={128} value={search} onChange={event => setSearch(event.target.value)} /></label><Button className={wrap} type="submit" variant="outline">Найти</Button><Button className={wrap} type="button" variant="outline" onClick={() => { setSearch(""); searchProjects(""); }}>Сбросить поиск</Button></form></CardHeader><CardContent className="min-w-0"><AdminPagedList query={projects} label="Доски" blocked={blocked} listRef={projectsRef}>{projectRows.map(row => <li key={row.id} className="min-w-0 space-y-2 border-b p-3"><p className="break-all font-medium"><SearchHighlight text={row.displayName ?? "Без названия"} query={q}/></p><p className="break-all text-xs">ID: <SearchHighlight text={row.id} query={q}/> · Подразделение: {row.departmentId ?? "не назначено"} · Группа: {row.responsibleGroupId ?? "не назначена"}</p><Button className={wrap} variant="outline" aria-pressed={projectId === row.id} onClick={() => select("project", row.id)}>Выбрать доску {row.id}</Button></li>)}</AdminPagedList></CardContent></Card>
      <Card><CardHeader><CardTitle>Подразделения</CardTitle><nav aria-label="Путь подразделений" className="flex min-w-0 flex-wrap gap-2"><Button className={wrap} variant="link" onClick={() => navigate([])}>Корень</Button>{trail.map((item, index) => <Button key={item.id} className={wrap} variant="link" onClick={() => navigate(trail.slice(0, index + 1))}><span className="block min-w-0 break-all">{index === trail.length - 1 && parent ? parent.name : item.name}</span></Button>)}</nav>{parent && <Button className={wrap} variant="outline" onClick={() => select("department", parent.id)}>Выбрать текущее подразделение</Button>}</CardHeader><CardContent className="min-w-0"><AdminPagedList query={departments} label="Подразделения" blocked={blocked}>{departmentRows.map(row => <li key={row.id} className="min-w-0 space-y-2 border-b p-3"><p className="break-all">{row.name} · {row.id} · {row.archived ? "Архивное" : "Активное"}</p><div className="flex flex-wrap gap-2"><Button className={wrap} variant="outline" aria-pressed={departmentId === row.id} onClick={() => select("department", row.id)}>Выбрать подразделение {row.id}</Button><Button className={wrap} variant="outline" onClick={() => navigate([...trail, { id: row.id, name: row.name }])}>Дочерние подразделения {row.id}</Button></div></li>)}</AdminPagedList></CardContent></Card>
      <Card><CardHeader><CardTitle>Группы</CardTitle><label className="grid gap-1 text-sm">Архив групп<select className="h-10 rounded-md border bg-background px-3" value={archive} onChange={event => { if (blocked || busy.current) return; setArchive(event.target.value); setGroupId(null); reload(); }}><option value="all">Все</option><option value="active">Активные</option><option value="archived">Архивные</option></select></label></CardHeader><CardContent className="min-w-0"><AdminPagedList query={groups} label="Группы" blocked={blocked}>{groupRows.map(row => <li key={row.id} className="min-w-0 space-y-2 border-b p-3"><p className="break-all">{row.name} · {row.id} · {row.archived ? "Архивная" : "Активная"}</p><Button className={wrap} variant="outline" aria-pressed={groupId === row.id} onClick={() => select("group", row.id)}>Выбрать группу {row.id}</Button></li>)}</AdminPagedList></CardContent></Card>
      <Card><CardHeader><CardTitle>Выбор и действия</CardTitle></CardHeader><CardContent className="min-w-0 space-y-3"><p className="break-all">Доска: {project ? `${project.displayName ?? "Без названия"} · ${project.id}` : "не выбрана"}</p><p className="break-all">Выбранное подразделение: {department ? `${department.name} · ${department.id}` : "не выбрано"}</p><p className="break-all">Выбранная группа: {group ? `${group.name} · ${group.id}` : "не выбрана"}</p><div className="flex flex-wrap gap-2"><Button className={wrap} disabled={!ready || !project || !department || department.archived} onClick={() => open("department")}>Назначить подразделение</Button><Button className={wrap} variant="outline" disabled={!ready || !project || !project.departmentId} onClick={() => open("clearDepartment")}>Снять подразделение</Button><Button className={wrap} disabled={!ready || !project || !group || group.archived} onClick={() => open("group")}>Назначить группу</Button><Button className={wrap} variant="outline" disabled={!ready || !project || !project.responsibleGroupId} onClick={() => open("clearGroup")}>Снять группу</Button><Button className={wrap} variant="outline" disabled={!ready || !project || (!project.departmentId && !project.responsibleGroupId)} onClick={() => open("clearBoth")}>Снять обе связи</Button></div></CardContent></Card>
    </fieldset>}
    {intent && <div ref={panelRef} tabIndex={-1} role="region" aria-label="Подтверждение привязок" className="min-w-0 space-y-3 rounded-md border p-3"><h2 className="font-semibold">Итоговые привязки</h2><p className="break-all">Доска: {intent.projectName ?? "Без названия"} · {intent.projectId}</p><p className="break-all">Итоговое подразделение (ID): {intent.departmentId ?? "нет"}</p><p className="break-all">Итоговая группа (ID): {intent.responsibleGroupId ?? "нет"}</p><p>Версия подтверждения: {intent.expectedVersion}</p>{staleIntent && failure !== "unknown" && <p role="alert">Данные изменились после открытия подтверждения. Обновите списки или закройте форму и задайте действие заново.</p>}{failure === "unknown" && <p role="alert">Результат неизвестен. Повтор отправит те же обе связи и исходную версию.</p>}{failure === "conflict" && <p role="alert">Конфликт версии или ограничений. Новые действия заблокированы до явного обновления данных.</p>}{failure === "rejected" && <p role="alert">Изменение отклонено. Проверьте ограничения привязок.</p>}<form onSubmit={confirm} className="flex flex-wrap gap-2">{failure === "unknown" ? <><Button className={wrap} type="button" disabled={pending} onClick={() => { if (command) void execute(command); }}>Повторить ту же операцию</Button><Button className={wrap} type="button" variant="outline" disabled={pending} onClick={reload}>Обновить без повтора</Button></> : failure === "conflict" ? <Button className={wrap} type="button" disabled={pending || fetching} onClick={reload}>Обновить после конфликта</Button> : <Button className={wrap} type="submit" disabled={!ready || staleIntent}>{pending ? "Сохранение…" : "Подтвердить"}</Button>}<Button className={wrap} type="button" variant="outline" disabled={blocked} onClick={close}>Закрыть</Button></form></div>}
  </div>;
}
