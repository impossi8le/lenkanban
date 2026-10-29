"use client";
import {SearchHighlight} from "@/components/ui/SearchHighlight";

import * as React from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { AdminPagedList, normalizeAdminSearch, resetAdminListQueries, uniqueById, useAdminPager } from "@/components/admin/admin-list";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ORGANIZATION_PRIVILEGE_MATRIX } from "@/lib/organization-contract";
import type { OrganizationDepartment, OrganizationDepartmentPage, OrganizationGroup, OrganizationGroupPage, OrganizationPeoplePage, OrganizationPerson, OrganizationPrivilegeProfile, OrganizationPrivilegeProfilePage, OrganizationProject, OrganizationProjectPage, OrganizationPrivilegeAssignment, OrganizationPrivilegeAssignmentPage, OrganizationGroupPrivilegeAssignment, OrganizationGroupPrivilegeAssignmentPage, OrganizationPrivilegeScope, OrganizationMutation } from "@/lib/organization-contract";

const prefix = "adminRoleAssignments", base = "/api/admin/organization";
const scopes = { organization: "Вся организация", department: "Отдел", board: "Доска" };
type Choice = { id: string; name: string };
type Payload = { groupId?: string; userId?: string; profileId: string; scopeKind: OrganizationPrivilegeScope; departmentId: string | null; projectId: string | null; assigned: boolean };
type Intent = { payload: Payload; subjectName: string; profileName: string; targetName: string; expectedVersion: number };
type Command = { intent: Intent; operationId: string; actionId: string };
function status(error: unknown): number | undefined { return error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : undefined; }
function denied(error: unknown) { return status(error) === 401 || status(error) === 403; }

export default function RoleAssignmentManager({ actorId }: { actorId: string }) {
  const { data: session, status: sessionStatus } = useSession();
  const client = useQueryClient();
  const [accessLost, setAccessLost] = React.useState(false);
  const matching = sessionStatus === "authenticated" && session?.user?.id === actorId && session.user.globalRole === "ADMIN";
  React.useEffect(() => {
    if (accessLost || (sessionStatus !== "loading" && !matching)) { void client.cancelQueries({ queryKey: [prefix, actorId] }); resetAdminListQueries(client, [prefix, actorId]); }
    return () => { void client.cancelQueries({ queryKey: [prefix, actorId] }); resetAdminListQueries(client, [prefix, actorId]); };
  }, [accessLost, matching, sessionStatus, actorId, client]);
  if (sessionStatus === "loading") return <p role="status" className="p-4">Проверка учётной записи…</p>;
  if (!matching || accessLost) return <div role="alert" className="space-y-3 p-4"><p>Учётная запись или права изменились. Назначения скрыты.</p><Button onClick={() => window.location.reload()}>Обновить страницу</Button></div>;
  return <Browser key={actorId} actorId={actorId} onDenied={() => setAccessLost(true)} />;
}

function Browser({ actorId, onDenied }: { actorId: string; onDenied: () => void }) {
  const client = useQueryClient();
  const [kind, setKind] = React.useState<"group" | "personal">("group");
  const [subject, setSubject] = React.useState<Choice | null>(null), [profile, setProfile] = React.useState<Choice | null>(null), [target, setTarget] = React.useState<Choice | null>(null);
  const [scopeKind, setScopeKind] = React.useState<OrganizationPrivilegeScope>("organization");
  const [search, setSearch] = React.useState(""), [q, setQ] = React.useState("");
  const [path, setPath] = React.useState<Choice[]>([]), [epoch, setEpoch] = React.useState(0);
  const [intent, setIntent] = React.useState<Intent | null>(null), [command, setCommand] = React.useState<Command | null>(null);
  const [pending, setPending] = React.useState(false), [failure, setFailure] = React.useState<"unknown" | "conflict" | "rejected" | null>(null), [notice, setNotice] = React.useState("");
  const busy = React.useRef(false), alive = React.useRef(true), panel = React.useRef<HTMLDivElement>(null), trigger = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const key = [prefix, actorId, epoch];
  const groups = useAdminPager<OrganizationGroup, OrganizationGroupPage>({ key: [...key, "groups"], url: `${base}/groups`, params: { archived: "active" }, enabled: kind === "group" });
  const people = useAdminPager<OrganizationPerson, OrganizationPeoplePage>({ key: [...key, "people", q], url: `${base}/people`, params: q ? { q } : {}, enabled: kind === "personal" });
  const profiles = useAdminPager<OrganizationPrivilegeProfile, OrganizationPrivilegeProfilePage>({ key: [...key, "profiles"], url: `${base}/privilege-profiles`, params: { archived: "all" } });
  const departments = useAdminPager<OrganizationDepartment, OrganizationDepartmentPage>({ key: [...key, "departments", path.at(-1)?.id], url: `${base}/departments`, params: { archived: "active", ...(path.length ? { parentId: path.at(-1)!.id } : {}) }, enabled: scopeKind === "department" });
  const projects = useAdminPager<OrganizationProject, OrganizationProjectPage>({ key: [...key, "projects"], url: `${base}/projects`, enabled: scopeKind === "board" });
  const personal = useAdminPager<OrganizationPrivilegeAssignment, OrganizationPrivilegeAssignmentPage>({ key: [...key, "personal", subject?.id], url: `${base}/privilege-assignments`, params: { userId: subject?.id ?? "" }, enabled: kind === "personal" && !!subject });
  const grouped = useAdminPager<OrganizationGroupPrivilegeAssignment, OrganizationGroupPrivilegeAssignmentPage>({ key: [...key, "grouped", subject?.id], url: `${base}/group-privilege-assignments`, params: { groupId: subject?.id ?? "" }, enabled: kind === "group" && !!subject });
  const queries = [profiles, kind === "group" ? groups : people, ...(scopeKind === "department" ? [departments] : scopeKind === "board" ? [projects] : []), ...(subject ? [kind === "group" ? grouped : personal] : [])];
  const version = profiles.data?.pages[0]?.version;
  const forbidden = queries.some(query => denied(query.error));
  React.useEffect(() => { if (forbidden) onDenied(); }, [forbidden, onDenied]);
  const mismatch = queries.some(query => status(query.error) === 409 || query.data?.pages.some(page => page.version !== version));
  const locked = pending || failure === "unknown" || failure === "conflict";
  const fetching = queries.some(query => query.isFetching);
  const ready = !locked && !mismatch && !forbidden && Number.isSafeInteger(version) && queries.every(query => !!query.data && !query.isError && !query.isFetching);
  const profileRows = uniqueById(profiles.data?.pages.flatMap(page => page.items) ?? []);
  const selectedProfile = profileRows.find(item => item.id === profile?.id);
  const compatibleScope = !!selectedProfile && (selectedProfile.visibility !== "own" || scopeKind === "board") && selectedProfile.permissions.every(permission => ORGANIZATION_PRIVILEGE_MATRIX[permission].scopeKinds.includes(scopeKind));
  const rows = uniqueById<OrganizationGroupPrivilegeAssignment | OrganizationPrivilegeAssignment>((kind === "group" ? grouped.data?.pages.flatMap(page => page.items) : personal.data?.pages.flatMap(page => page.items)) ?? []);
  function clear() { setIntent(null); setCommand(null); setFailure(null); }
  function reload() { if (busy.current) return; clear(); setProfile(null); setTarget(null); resetAdminListQueries(client, [prefix, actorId]); setEpoch(value => value + 1); }
  function change(action: () => void) { if (locked || busy.current) return; clear(); action(); }
  function prepare(payload: Payload, profileName: string, targetName: string) {
    if (!ready || version === undefined || !subject) return;
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setIntent({ payload, profileName, targetName, subjectName: subject.name, expectedVersion: version }); setNotice(""); setFailure(null); setCommand(null);
    setTimeout(() => panel.current?.focus(), 0);
  }
  async function execute(next: Command) {
    if (busy.current) return;
    busy.current = true; setPending(true); setCommand(next); setFailure(null);
    try {
      const result = await apiFetch<OrganizationMutation<unknown>>(`${base}/${next.intent.payload.groupId ? "group-privilege-assignments" : "privilege-assignments"}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Action-Id": next.actionId }, body: JSON.stringify({ ...next.intent.payload, operationId: next.operationId, expectedVersion: next.intent.expectedVersion }) });
      if (!alive.current) return;
      clear(); setProfile(null); setTarget(null); setNotice(result.replayed ? "Ранее сохранённая операция подтверждена." : "Назначение сохранено.");
      try { await client.invalidateQueries({ queryKey: [prefix, actorId] }); }
      catch { if (alive.current) setNotice("Назначение сохранено, но перечитать данные не удалось. Обновите данные ролей."); }
    } catch (error) {
      if (!alive.current) return;
      if (denied(error)) { onDenied(); return; }
      const code = status(error); setFailure(code === 409 ? "conflict" : code === undefined || code >= 500 ? "unknown" : "rejected");
    } finally { if (alive.current) { busy.current = false; setPending(false); } }
  }
  if (forbidden) return null;
  return <div className="min-w-0 space-y-4 p-4 sm:p-6">
    <h1 className="text-xl font-bold sm:text-2xl">Роли групп и сотрудников</h1>
    <p>Роли группы и личные роли складываются. Удаление из группы убирает только её права. Отдел и доступность заявки дополнительно ограничивают исполнение.</p>
    <p><Link className="underline" href="/admin/organization/privileges">Настроить профили ролей и проверить итоговые права</Link></p>
    <p className="text-sm text-muted-foreground">Глобальный администратор назначается отдельно. Роль с таким названием не предоставляет полный доступ.</p>
    <Button variant="outline" disabled={pending || fetching} onClick={reload}>Обновить данные ролей</Button>
    {notice && <p role="status">{notice}</p>}
    {mismatch ? <p role="alert">Версии данных различаются. Обновите данные ролей перед изменениями.</p> : <fieldset disabled={locked} className="min-w-0 space-y-4">
      <label className="grid gap-1">Источник назначения<select className="rounded-md border bg-background p-2" value={kind} onChange={event => change(() => { setKind(event.target.value as typeof kind); setSubject(null); })}><option value="group">Группа</option><option value="personal">Лично сотруднику</option></select></label>
      <Card><CardHeader><CardTitle>{kind === "group" ? "Выберите группу" : "Выберите сотрудника"}</CardTitle>{kind === "personal" && <form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); change(() => { setSubject(null); setQ(normalizeAdminSearch(search)); resetAdminListQueries(client, [prefix, actorId, epoch, "people"]); }); }}><label>Имя сотрудника<Input value={search} maxLength={128} onChange={event => setSearch(event.target.value)} /></label><Button type="submit">Найти сотрудника</Button></form>}</CardHeader><CardContent>
        {kind === "group" ? <AdminPagedList query={groups} label="Группы для роли" blocked={locked}>{uniqueById(groups.data?.pages.flatMap(page => page.items) ?? []).map(row => <li className="border-b p-2" key={row.id}><Button variant="link" className="h-auto max-w-full whitespace-normal text-left" aria-pressed={subject?.id === row.id} onClick={() => change(() => setSubject({ id: row.id, name: row.name }))}>{row.name}</Button></li>)}</AdminPagedList> : <AdminPagedList query={people} label="Сотрудники для роли" blocked={locked}>{uniqueById(people.data?.pages.flatMap(page => page.items) ?? []).map(row => <li className="border-b p-2" key={row.id}><Button variant="link" className="h-auto max-w-full whitespace-normal text-left" aria-pressed={subject?.id === row.id} onClick={() => change(() => setSubject({ id: row.id, name: row.displayName ?? row.id }))}><SearchHighlight text={row.displayName ?? "Без имени"} query={q}/> · {row.id}</Button></li>)}</AdminPagedList>}
      </CardContent></Card>
      {subject && <Card><CardHeader><CardTitle>Назначения: {subject.name}</CardTitle></CardHeader><CardContent className="space-y-3"><p>Источник: {kind === "group" ? "через группу" : "назначено лично"}. Здесь показаны только назначения выбранного источника.</p>
        {kind === "group" ? <AdminPagedList query={grouped} label="Групповые роли" blocked={locked}>{rows.map(renderAssignment)}</AdminPagedList> : <AdminPagedList query={personal} label="Личные роли" blocked={locked}>{rows.map(renderAssignment)}</AdminPagedList>}
      </CardContent></Card>}
      <Card><CardHeader><CardTitle>Назначить роль</CardTitle></CardHeader><CardContent className="space-y-3">
        <AdminPagedList query={profiles} label="Роли для назначения" blocked={locked}>{profileRows.map(row => <li className="border-b p-2" key={row.id}><Button variant="link" disabled={row.archived} aria-pressed={profile?.id === row.id} onClick={() => change(() => setProfile({ id: row.id, name: row.name }))}>{row.name}{row.archived ? " (архив)" : ""}</Button></li>)}</AdminPagedList>
        <label className="grid gap-1">Область роли<select className="rounded-md border bg-background p-2" value={scopeKind} onChange={event => change(() => { setScopeKind(event.target.value as OrganizationPrivilegeScope); setTarget(null); setPath([]); })}>{Object.entries(scopes).map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select></label>
        {scopeKind === "department" && <><p>Раздел: {path.map(item => item.name).join(" / ") || "Корневые отделы"}</p>{path.length > 0 && <Button variant="outline" onClick={() => change(() => setPath(value => value.slice(0, -1)))}>На уровень выше</Button>}<AdminPagedList query={departments} label="Отделы для роли" blocked={locked}>{uniqueById(departments.data?.pages.flatMap(page => page.items) ?? []).map(row => <li className="flex flex-wrap gap-2 border-b p-2" key={row.id}><Button variant="link" aria-pressed={target?.id === row.id} onClick={() => change(() => setTarget({ id: row.id, name: row.name }))}>{row.name}</Button><Button variant="outline" onClick={() => change(() => setPath(value => [...value, { id: row.id, name: row.name }]))}>Подотделы: {row.name}</Button></li>)}</AdminPagedList></>}
        {scopeKind === "board" && <AdminPagedList query={projects} label="Доски для роли" blocked={locked}>{uniqueById(projects.data?.pages.flatMap(page => page.items) ?? []).map(row => <li className="border-b p-2" key={row.id}><Button variant="link" aria-pressed={target?.id === row.id} onClick={() => change(() => setTarget({ id: row.id, name: row.displayName ?? row.id }))}><SearchHighlight text={row.displayName ?? "Без названия"} query={q}/> · {row.id}</Button></li>)}</AdminPagedList>}
        <p>Выбрано: {subject?.name ?? "получатель не выбран"} → {profile?.name ?? "роль не выбрана"} → {scopeKind === "organization" ? scopes.organization : target?.name ?? "область не выбрана"}</p>
        {profile && !compatibleScope && <p role="alert">Для этой роли выберите другую область. Видимость «свои заявки» поддерживает только доску; отдельные разрешения ограничены своей областью.</p>}
        <Button disabled={!ready || !subject || !profile || !compatibleScope || scopeKind !== "organization" && !target} onClick={() => { if (!subject || !profile || !compatibleScope) return; prepare({ ...(kind === "group" ? { groupId: subject.id } : { userId: subject.id }), profileId: profile.id, scopeKind, departmentId: scopeKind === "department" ? target!.id : null, projectId: scopeKind === "board" ? target!.id : null, assigned: true }, profile.name, scopeKind === "organization" ? scopes.organization : target!.name); }}>Подготовить назначение роли</Button>
      </CardContent></Card>
    </fieldset>}
    {intent && <div ref={panel} role="region" aria-label="Подтверждение роли" tabIndex={-1} className="space-y-3 rounded-md border p-3"><h2 className="font-semibold">{intent.payload.assigned ? "Назначить" : "Отозвать"} роль</h2><p>{intent.subjectName} → {intent.profileName} → {intent.targetName}</p><p>Источник: {intent.payload.groupId ? "через группу" : "назначено лично"}. Версия: {intent.expectedVersion}</p>
      {failure === "unknown" && <p role="alert">Результат неизвестен. Повтор отправит ту же операцию и исходную версию.</p>}{failure === "conflict" && <p role="alert">Конфликт версии. Обновите данные и подготовьте действие заново.</p>}{failure === "rejected" && <p role="alert">Изменение отклонено. Проверьте роль и область.</p>}
      <div className="flex flex-wrap gap-2">{failure === "unknown" ? <Button disabled={pending} onClick={() => { if (command) void execute(command); }}>Повторить ту же операцию</Button> : failure !== "conflict" && <Button disabled={!ready || intent.expectedVersion !== version} onClick={() => { if (!ready || intent.expectedVersion !== version) return; try { void execute({ intent, operationId: crypto.randomUUID(), actionId: crypto.randomUUID() }); } catch { setNotice("Не удалось подготовить операцию. Обновите страницу."); } }}>Подтвердить роль</Button>}<Button variant="outline" disabled={locked} onClick={() => { clear(); trigger.current?.focus(); }}>Закрыть</Button></div>
    </div>}
  </div>;

  function renderAssignment(row: OrganizationPrivilegeAssignment | OrganizationGroupPrivilegeAssignment) {
    const display = row as typeof row & { profileName?: string; departmentName?: string; projectName?: string };
    const name = display.profileName ?? profileRows.find(item => item.id === row.profileId)?.name ?? row.profileId;
    const targetName = display.departmentName ?? display.projectName ?? departments.data?.pages.flatMap(page => page.items).find(item => item.id === row.departmentId)?.name ?? projects.data?.pages.flatMap(page => page.items).find(item => item.id === row.projectId)?.displayName ?? row.departmentId ?? row.projectId ?? scopes.organization;
    return <li className="space-y-2 border-b p-2" key={row.id}><p>{name} · {scopes[row.scopeKind]} · {targetName} · {row.assigned ? "назначена" : "отозвана"}</p>{row.assigned && <Button variant="outline" disabled={!ready} onClick={() => prepare({ ...(kind === "group" ? { groupId: subject!.id } : { userId: subject!.id }), profileId: row.profileId, scopeKind: row.scopeKind, departmentId: row.departmentId, projectId: row.projectId, assigned: false }, name, targetName)}>Отозвать роль {name}</Button>}</li>;
  }
}
