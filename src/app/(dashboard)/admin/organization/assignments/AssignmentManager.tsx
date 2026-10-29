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
import type { OrganizationDepartment, OrganizationDepartmentPage, OrganizationPerson, OrganizationPeoplePage, OrganizationMutation } from "@/lib/organization-contract";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";

const prefix = "adminAssignments";
const base = "/api/admin/organization";
const wrap = "h-auto min-h-11 max-w-full whitespace-normal break-all";
type Intent = { kind: "leader"; department: OrganizationDepartment; person: OrganizationPerson | null } | { kind: "primary"; person: OrganizationPerson; department: OrganizationDepartment | null };
type Command = { url: string; actionId: string; body: Record<string, string | number | null> };
function status(error: unknown): number | undefined { try { return error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : undefined; } catch { return undefined; } }
function denied(error: unknown) { return status(error) === 401 || status(error) === 403; }

export default function AssignmentManager({ actorId }: { actorId: string }) {
  const { data: session, status: sessionStatus } = useSession();
  const client = useQueryClient();
  const [accessLost, setAccessLost] = React.useState(false);
  const matching = sessionStatus === "authenticated" && session?.user?.id === actorId && session.user.globalRole === "ADMIN";
  React.useEffect(() => {
    if (accessLost || (sessionStatus !== "loading" && !matching)) { void client.cancelQueries({ queryKey: [prefix, actorId] }); resetAdminListQueries(client, [prefix, actorId]); }
    return () => { void client.cancelQueries({ queryKey: [prefix, actorId] }); resetAdminListQueries(client, [prefix, actorId]); };
  }, [actorId, client, matching, sessionStatus, accessLost]);
  if (sessionStatus === "loading") return <p role="status" className="p-4">Проверка учётной записи…</p>;
  if (!matching || accessLost) return <div role="alert" className="space-y-3 p-4"><p>Учётная запись или права изменились. Данные назначений скрыты.</p><Button className={wrap} onClick={() => window.location.reload()}>Обновить страницу</Button></div>;
  return <AssignmentBrowser key={actorId} actorId={actorId} onDenied={() => setAccessLost(true)} />;
}

function AssignmentBrowser({ actorId, onDenied }: { actorId: string; onDenied: () => void }) {
  const client = useQueryClient();
  const [trail, setTrail] = React.useState<{ id: string; name: string }[]>([]);
  const [archive, setArchive] = React.useState("all");
  const [search, setSearch] = React.useState("");
  const [q, setQ] = React.useState("");
  const [epoch, setEpoch] = React.useState(0);
  const [peopleEpoch, setPeopleEpoch] = React.useState(0);
  const [departmentId, setDepartmentId] = React.useState<string | null>(null);
  const [personId, setPersonId] = React.useState<string | null>(null);
  const [intent, setIntent] = React.useState<Intent | null>(null);
  const [command, setCommand] = React.useState<Command | null>(null);
  const [pending, setPending] = React.useState(false);
  const [failure, setFailure] = React.useState<"unknown" | "conflict" | "rejected" | null>(null);
  const [notice, setNotice] = React.useState("");
  const busy = React.useRef(false), scope = React.useRef(0);
  const departmentsRef = React.useRef<HTMLDivElement>(null), panelRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLElement | null>(null), restoreFocus = React.useRef(false);
  React.useEffect(() => () => { scope.current++; }, []);
  const parentId = trail.at(-1)?.id ?? null;
  const departments = useAdminPager<OrganizationDepartment, OrganizationDepartmentPage>({ key: [prefix, actorId, "departments", parentId, archive, epoch], url: `${base}/departments`, params: { archived: archive, ...(parentId ? { parentId } : {}) } });
  const people = useAdminPager<OrganizationPerson, OrganizationPeoplePage>({ key: [prefix, actorId, "people", q, epoch, peopleEpoch], url: `${base}/people`, params: q ? { q } : {} });
  const queries = [departments, people];
  const forbidden = queries.some(query => denied(query.error));
  React.useEffect(() => { if (forbidden) onDenied(); }, [forbidden, onDenied]);
  const version = departments.data?.pages[0]?.version;
  const mismatch = queries.some(query => status(query.error) === 409 || query.data?.pages.some(page => page.version !== version));
  const fetching = queries.some(query => query.isFetching);
  const locked = pending || failure === "unknown";
  const ready = !forbidden && !mismatch && Number.isSafeInteger(version) && !locked && failure !== "conflict" && queries.every(query => !!query.data && !query.isFetching && !query.isError);
  const departmentRows = uniqueById(departments.data?.pages.flatMap(page => page.items) ?? []);
  const peopleRows = uniqueById(people.data?.pages.flatMap(page => page.items) ?? []);
  const parent = departments.data?.pages[0]?.parent;
  const selectedDepartment = parent?.id === departmentId ? parent : departmentRows.find(row => row.id === departmentId);
  const selectedPerson = peopleRows.find(row => row.id === personId);
  React.useEffect(() => { if (restoreFocus.current && departments.data && !fetching && !mismatch && !forbidden) { restoreFocus.current = false; departmentsRef.current?.focus(); } }, [departments.data, fetching, mismatch, forbidden]);
  function reset() {
    if (busy.current) return;
    restoreFocus.current = true; resetAdminListQueries(client, [prefix, actorId]);
    setIntent(null); setCommand(null); setFailure(null); setEpoch(value => value + 1);
  }
  function navigate(next: typeof trail) {
    if (locked || busy.current) return;
    setTrail(next); setDepartmentId(null); setNotice(""); reset();
  }
  function chooseDepartment(id: string) { if (locked || busy.current || failure === "conflict") return; setDepartmentId(id); setIntent(null); setCommand(null); setFailure(null); }
  function choosePerson(id: string) { if (locked || busy.current || failure === "conflict") return; setPersonId(id); setIntent(null); setCommand(null); setFailure(null); }
  function open(next: Intent) {
    if (!ready) return;
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setIntent(next); setCommand(null); setFailure(null); setNotice(""); setTimeout(() => panelRef.current?.focus(), 0);
  }
  function close() { if (locked || busy.current || failure === "conflict") return; setIntent(null); setFailure(null); setCommand(null); triggerRef.current?.focus(); }
  async function execute(next: Command) {
    if (busy.current) return;
    busy.current = true; setPending(true); setCommand(next); setFailure(null);
    const requestScope = scope.current;
    try {
      const result = await apiFetch<OrganizationMutation<unknown>>(next.url, { method: "PATCH", headers: { "Content-Type": "application/json", "X-Action-Id": next.actionId }, body: JSON.stringify(next.body) });
      if (requestScope !== scope.current) return;
      setIntent(null); setCommand(null); setNotice(result.replayed ? "Ранее сохранённая операция подтверждена. Обновляем данные." : "Изменение сохранено. Обновляем данные.");
      try {
        await client.invalidateQueries({ queryKey: [prefix, actorId] });
        if (requestScope === scope.current) setNotice(result.replayed ? "Ранее сохранённая операция подтверждена. Проверьте актуальные данные ниже." : "Изменение сохранено. Проверьте актуальные данные ниже.");
      } catch { if (requestScope === scope.current) setNotice("Изменение сохранено, но перечитать данные не удалось. Обновите списки перед следующим действием."); }
      if (requestScope === scope.current) departmentsRef.current?.focus();
    } catch (error) {
      if (requestScope !== scope.current) return;
      if (denied(error)) { onDenied(); return; }
      const code = status(error); setFailure(code === 409 ? "conflict" : code === undefined || code >= 500 ? "unknown" : "rejected");
    } finally { if (requestScope === scope.current) { busy.current = false; setPending(false); } }
  }
  function confirm(event: React.FormEvent) {
    event.preventDefault(); if (!ready || !intent || busy.current || version === undefined) return;
    let operationId: string, actionId: string; try { operationId = crypto.randomUUID(); actionId = crypto.randomUUID(); } catch { setNotice("Не удалось подготовить операцию. Обновите страницу."); return; }
    const meta = { operationId, expectedVersion: version };
    if (intent.kind === "leader") {
      if (intent.person && intent.department.archived) return;
      void execute({ url: `${base}/departments/${encodeURIComponent(intent.department.id)}`, actionId, body: { kind: "leader", leaderId: intent.person?.id ?? null, ...meta } });
    } else {
      if (intent.department?.archived) return;
      void execute({ url: `${base}/people/${encodeURIComponent(intent.person.id)}`, actionId, body: { departmentId: intent.department?.id ?? null, ...meta } });
    }
  }
  function searchPeople(value: string) {
    if (locked || busy.current || failure === "conflict") return;
    resetAdminListQueries(client, [prefix, actorId, "people"]); setQ(normalizeAdminSearch(value)); setPeopleEpoch(number => number + 1);
    setPersonId(null); setIntent(null); setCommand(null); setFailure(null);
  }
  if (forbidden) return null;
  return <div className="min-w-0 space-y-4 p-4 sm:p-6">
    <h1 className="text-xl font-bold break-words sm:text-2xl">Организационные назначения</h1>
    <p className="text-sm text-muted-foreground">Выберите подразделение и сотрудника явно. Руководитель выбирается из всех пользователей и не переводится в подразделение автоматически. Эти настройки не выдают права на доски и заявки.</p>
    <Button className={wrap} variant="outline" disabled={locked || fetching} onClick={reset}>Обновить все данные</Button>
    {notice && <p role="status">{notice}</p>}
    {mismatch ? <div role="alert" className="space-y-2"><p>Версии списков различаются или снимок устарел. Данные скрыты; обновите их перед изменением.</p><Button className={wrap} disabled={locked || fetching} onClick={reset}>Загрузить актуальные списки</Button></div> : <fieldset aria-label="Выбор назначения" disabled={locked || failure === "conflict"} className="min-w-0 space-y-4">
      <Card><CardHeader><CardTitle>Подразделения</CardTitle><CardDescription>Показаны только непосредственные дочерние узлы. Выбор и просмотр дочерних подразделений — разные действия.</CardDescription>
        <nav aria-label="Путь подразделений" className="flex min-w-0 flex-wrap items-center gap-2"><Button className={wrap} variant="link" disabled={locked} onClick={() => navigate([])}>Корень</Button>{trail.map((item, index) => <React.Fragment key={item.id}><span aria-hidden="true">/</span><Button className={wrap} variant="link" disabled={locked} onClick={() => navigate(trail.slice(0, index + 1))}><span className="block min-w-0 break-all">{index === trail.length - 1 && parent ? parent.name : item.name}</span></Button></React.Fragment>)}</nav>
        <label className="grid gap-1 text-sm">Архив подразделений<select className="h-10 rounded-md border bg-background px-3" value={archive} disabled={locked} onChange={event => { setArchive(event.target.value); setDepartmentId(null); reset(); }}><option value="all">Все</option><option value="active">Активные</option><option value="archived">Архивные</option></select></label>
        {parent && <div className="space-y-2"><p className="break-all text-sm">Текущий родитель: {parent.name} · {parent.id}</p><Button className={wrap} variant="outline" disabled={locked} onClick={() => chooseDepartment(parent.id)}>Выбрать текущее подразделение</Button></div>}
      </CardHeader><CardContent className="min-w-0"><AdminPagedList query={departments} label="Подразделения" blocked={locked} listRef={departmentsRef}>{departmentRows.map(row => <li key={row.id} className="min-w-0 space-y-2 border-b p-3"><p className="break-all font-medium">{row.name}</p><p className="break-all text-xs text-muted-foreground">{row.id} · {row.archived ? "Архивное" : "Активное"}</p><div className="flex flex-wrap gap-2"><Button className={wrap} size="sm" variant="outline" disabled={locked} aria-pressed={departmentId === row.id} onClick={() => chooseDepartment(row.id)}>Выбрать подразделение {row.id}</Button><Button className={wrap} size="sm" variant="outline" disabled={locked} onClick={() => navigate([...trail, { id: row.id, name: row.name }])}>Дочерние подразделения {row.id}</Button></div></li>)}</AdminPagedList></CardContent></Card>
      <Card><CardHeader><CardTitle>Сотрудники</CardTitle><CardDescription>Поиск по имени или ID во всех подразделениях. Выбор сотрудника не меняет данные.</CardDescription><form className="flex min-w-0 flex-wrap gap-2" onSubmit={event => { event.preventDefault(); searchPeople(search); }}><label className="grid w-full min-w-0 basis-full gap-1 text-sm sm:w-auto sm:basis-0 sm:flex-1">Имя или ID<Input className="w-full min-w-0" maxLength={128} value={search} disabled={locked} onChange={event => setSearch(event.target.value)} /></label><Button className={wrap} type="submit" variant="outline" disabled={locked}>Найти</Button><Button className={wrap} type="button" variant="outline" disabled={locked} onClick={() => { setSearch(""); searchPeople(""); }}>Сбросить поиск</Button></form></CardHeader><CardContent className="min-w-0"><AdminPagedList query={people} label="Сотрудники" blocked={locked}>{peopleRows.map(row => <li key={row.id} className="min-w-0 space-y-2 border-b p-3"><Person person={row} query={q}/><Button className={wrap} size="sm" variant="outline" disabled={locked} aria-pressed={personId === row.id} onClick={() => choosePerson(row.id)}>Выбрать сотрудника {row.id}</Button></li>)}</AdminPagedList></CardContent></Card>
      <Card><CardHeader><CardTitle>Выбор и действия</CardTitle></CardHeader><CardContent className="min-w-0 space-y-4">
        {selectedDepartment ? <div className="space-y-1"><p className="break-all">Подразделение: {selectedDepartment.name} · {selectedDepartment.id}</p><p className="break-all text-sm">Текущий руководитель (ID): {selectedDepartment.leaderId ?? "не назначен"}</p><p className="text-sm">{selectedDepartment.archived ? "Архивное: новые назначения недоступны." : "Активное подразделение."}</p></div> : <p>Подразделение не выбрано в текущем списке.</p>}
        {selectedPerson ? <div><p className="font-medium">Выбранный сотрудник</p><Person person={selectedPerson} /></div> : <p>Сотрудник не выбран в текущем списке.</p>}
        <div className="flex flex-wrap gap-2"><Button className={wrap} disabled={!ready || !selectedDepartment || !selectedPerson || selectedDepartment.archived} onClick={() => { if (selectedDepartment && selectedPerson) open({ kind: "leader", department: selectedDepartment, person: selectedPerson }); }}>Назначить руководителя</Button><Button className={wrap} variant="outline" disabled={!ready || !selectedDepartment || !selectedDepartment.leaderId} onClick={() => { if (selectedDepartment) open({ kind: "leader", department: selectedDepartment, person: null }); }}>Снять руководителя</Button></div>
        <div className="flex flex-wrap gap-2"><Button className={wrap} disabled={!ready || !selectedDepartment || !selectedPerson || selectedDepartment.archived} onClick={() => { if (selectedDepartment && selectedPerson) open({ kind: "primary", department: selectedDepartment, person: selectedPerson }); }}>Назначить основное подразделение</Button><Button className={wrap} variant="outline" disabled={!ready || !selectedPerson || !selectedPerson.primaryDepartmentId} onClick={() => { if (selectedPerson) open({ kind: "primary", department: null, person: selectedPerson }); }}>Снять основное подразделение</Button></div>
      </CardContent></Card>
    </fieldset>}
    {intent && <div ref={panelRef} tabIndex={-1} role="region" aria-label="Подтверждение назначения" className="min-w-0 space-y-3 rounded-md border p-3"><h2 className="break-all font-semibold">{intent.kind === "leader" ? intent.person ? "Назначить руководителя" : "Снять руководителя" : intent.department ? "Назначить основное подразделение" : "Снять основное подразделение"}</h2>
      {intent.department && <p className="break-all text-sm">Подразделение: {intent.department.name} · {intent.department.id}</p>}{intent.person && <Person person={intent.person} />}
      <form className="space-y-3" onSubmit={confirm}>{failure === "unknown" && <p role="alert">Результат неизвестен: операция могла сохраниться. Повтор отправит те же параметры, UUID и исходную версию.</p>}{failure === "conflict" && <p role="alert">Конфликт версии или ограничений. Обновите данные и задайте действие заново; автоматического повтора нет.</p>}{failure === "rejected" && <p role="alert">Изменение отклонено. Проверьте назначения и ограничения подразделения.</p>}<div className="flex flex-wrap gap-2">{failure === "unknown" ? <><Button className={wrap} type="button" disabled={pending} onClick={() => { if (command) void execute(command); }}>Повторить ту же операцию</Button><Button className={wrap} type="button" variant="outline" disabled={pending} onClick={reset}>Обновить без повтора</Button></> : failure === "conflict" ? <Button className={wrap} type="button" disabled={pending || fetching} onClick={reset}>Обновить после конфликта</Button> : <Button className={wrap} type="submit" disabled={!ready}>{pending ? "Сохранение…" : "Подтвердить"}</Button>}<Button className={wrap} type="button" variant="outline" disabled={locked || failure === "conflict"} onClick={close}>Закрыть</Button></div></form>
    </div>}
  </div>;
}

function Person({ person,query }: { person: OrganizationPerson;query?:string }) { return <div className="min-w-0 max-w-full space-y-1"><p className="break-all text-sm"><SearchHighlight text={person.displayName ?? "Имя не указано"} query={query}/></p><p className="break-all text-xs text-muted-foreground">ID: <SearchHighlight text={person.id} query={query}/> · Основное подразделение (ID): {person.primaryDepartmentId ?? "не назначено"}</p></div>; }
