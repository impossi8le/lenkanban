"use client";
import {SearchHighlight} from "@/components/ui/SearchHighlight";

import * as React from "react";
import { useSession } from "next-auth/react";
import { useQueryClient } from "@tanstack/react-query";
import type { OrganizationGroup, OrganizationMutation, OrganizationPerson, OrganizationGroupPage, OrganizationGroupMemberPage, OrganizationPeoplePage } from "@/lib/organization-contract";
import { apiFetch } from "@/lib/api";
import {
  AdminPagedList,
  normalizeAdminSearch,
  resetAdminListQueries,
  uniqueById,
  useAdminPager,
} from "@/components/admin/admin-list";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import GroupLeadershipEditor from "./GroupLeadershipEditor";

type Person = OrganizationPerson;
type Editor = { kind: "create" } | { kind: "rename"; group: OrganizationGroup } | { kind: "archive"; group: OrganizationGroup } | { kind: "member"; group: OrganizationGroup; person: Person; member: boolean };
type Command = { method: "POST" | "PATCH"; url: string; body: Record<string, string | number | boolean> };
const prefix = "adminGroups";
const endpoint = "/api/admin/organization/groups";
function status(error: unknown): number | undefined {
  try { return error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : undefined; } catch { return undefined; }
}
function denied(error: unknown) { return status(error) === 401 || status(error) === 403; }

export default function GroupManager({ actorId }: { actorId: string }) {
  const { data: session, status: sessionStatus } = useSession();
  const client = useQueryClient();
  const [accessLost, setAccessLost] = React.useState(false);
  const matching = sessionStatus === "authenticated" && session?.user?.id === actorId && session.user.globalRole === "ADMIN";
  React.useEffect(() => {
    if (accessLost || (sessionStatus !== "loading" && !matching)) { void client.cancelQueries({ queryKey: [prefix, actorId] }); resetAdminListQueries(client, [prefix, actorId]); }
    return () => { void client.cancelQueries({ queryKey: [prefix, actorId] }); resetAdminListQueries(client, [prefix, actorId]); };
  }, [actorId, client, accessLost, matching, sessionStatus]);
  if (sessionStatus === "loading") return <p role="status" className="p-4">Проверка учётной записи…</p>;
  if (!matching || accessLost) return <div role="alert" className="space-y-3 p-4"><p>Учётная запись или права изменились. Данные групп скрыты.</p><Button onClick={() => window.location.reload()}>Обновить страницу</Button></div>;
  return <GroupBrowser key={actorId} actorId={actorId} onDenied={() => setAccessLost(true)} />;
}

function GroupBrowser({ actorId, onDenied }: { actorId: string; onDenied: () => void }) {
  const client = useQueryClient();
  const [archived, setArchived] = React.useState("all");
  const [selected, setSelected] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState("");
  const [q, setQ] = React.useState("");
  const [epoch, setEpoch] = React.useState(0);
  const [peopleEpoch, setPeopleEpoch] = React.useState(0);
  const [editor, setEditor] = React.useState<Editor | null>(null);
  const [name, setName] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [leadershipBlocked, setLeadershipBlocked] = React.useState(false);
  const [command, setCommand] = React.useState<Command | null>(null);
  const [failure, setFailure] = React.useState<"unknown" | "conflict" | "rejected" | null>(null);
  const [notice, setNotice] = React.useState("");
  const busy = React.useRef(false), scope = React.useRef(0);
  const panelRef = React.useRef<HTMLDivElement>(null), groupsRef = React.useRef<HTMLDivElement>(null);
  const membersRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLElement | null>(null);
  const restoreFocus = React.useRef(false);
  const restoreMembersFocus = React.useRef(false);
  React.useEffect(() => () => { scope.current++; }, []);
  const groups = useAdminPager<OrganizationGroup, OrganizationGroupPage>({ key: [prefix, actorId, "groups", archived, epoch], url: endpoint, params: { archived } });
  const members = useAdminPager<Person, OrganizationGroupMemberPage>({ key: [prefix, actorId, "members", selected, epoch], url: `${endpoint}/${encodeURIComponent(selected ?? "")}/members`, enabled: selected !== null });
  const people = useAdminPager<Person, OrganizationPeoplePage>({ key: [prefix, actorId, "people", q, epoch, peopleEpoch], url: "/api/admin/organization/people", params: q ? { q } : {}, enabled: selected !== null });
  const queries = selected ? [groups, members, people] : [groups];
  const forbidden = queries.some(query => denied(query.error));
  React.useEffect(() => { if (forbidden) onDenied(); }, [forbidden, onDenied]);
  const version = groups.data?.pages[0]?.version;
  const snapshotConflict = queries.some(query => status(query.error) === 409 || query.data?.pages.some(page => page.version !== version));
  const fetching = queries.some(query => query.isFetching);
  // Keep mutation conflicts latched across selection/search/editor changes.
  // Only an explicit resetViews discards the stale snapshot and unlocks them.
  const locked = leadershipBlocked || pending || failure === "unknown" || failure === "conflict";
  const ready = !forbidden && !snapshotConflict && Number.isSafeInteger(version) && !locked && queries.every(query => !!query.data && !query.isError && !query.isFetching);
  const groupRows = uniqueById(groups.data?.pages.flatMap(page => page.items) ?? []);
  const memberRows = uniqueById(members.data?.pages.flatMap(page => page.items) ?? []);
  const peopleRows = uniqueById(people.data?.pages.flatMap(page => page.items) ?? []);
  const currentGroup = members.data?.pages[0]?.group ?? groupRows.find(group => group.id === selected);
  const loadedMemberIds = new Set(memberRows.map(person => person.id));
  React.useEffect(() => { if (restoreFocus.current && groups.data && !fetching && !snapshotConflict && !forbidden) { restoreFocus.current = false; groupsRef.current?.focus(); } }, [groups.data, fetching, snapshotConflict, forbidden]);
  React.useEffect(() => { if (restoreMembersFocus.current && members.data && !fetching && !snapshotConflict && !forbidden) { restoreMembersFocus.current = false; membersRef.current?.focus(); } }, [members.data, fetching, snapshotConflict, forbidden]);

  function resetViews() {
    if (busy.current) return;
    restoreFocus.current = true;
    resetAdminListQueries(client, [prefix, actorId]);
    setEditor(null); setCommand(null); setFailure(null); setEpoch(value => value + 1);
  }
  function selectGroup(id: string) {
    if (locked || busy.current) return;
    restoreMembersFocus.current = true;
    resetAdminListQueries(client, [prefix, actorId, "members"]); resetAdminListQueries(client, [prefix, actorId, "people"]);
    setSelected(id); setSearch(""); setQ(""); setEditor(null); setCommand(null); setFailure(null); setNotice("");
    setEpoch(value => value + 1);
  }
  function open(next: Editor) {
    if (!ready) return;
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditor(next); setName(next.kind === "rename" ? next.group.name : ""); setFailure(null); setCommand(null); setNotice("");
    setTimeout(() => panelRef.current?.focus(), 0);
  }
  function close() { if (locked || busy.current) return; setEditor(null); setCommand(null); setFailure(null); triggerRef.current?.focus(); }
  async function execute(next: Command) {
    if (busy.current) return;
    busy.current = true; setPending(true); setCommand(next); setFailure(null);
    const requestScope = scope.current;
    try {
      const result = await apiFetch<OrganizationMutation<unknown>>(next.url, { method: next.method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(next.body) });
      if (requestScope !== scope.current) return;
      setEditor(null); setCommand(null); setNotice(result.replayed ? "Ранее сохранённая операция подтверждена. Обновляем данные." : "Изменение сохранено. Обновляем данные.");
      try {
        await client.invalidateQueries({ queryKey: [prefix, actorId] });
        if (requestScope === scope.current) setNotice(result.replayed ? "Ранее сохранённая операция подтверждена. Проверьте актуальные списки ниже." : "Изменение сохранено. Проверьте актуальные списки ниже.");
      } catch { if (requestScope === scope.current) setNotice("Изменение сохранено, но перечитать данные не удалось. Обновите списки перед следующим действием."); }
      if (requestScope === scope.current) groupsRef.current?.focus();
    } catch (error) {
      if (requestScope !== scope.current) return;
      if (denied(error)) { onDenied(); return; }
      const code = status(error); setFailure(code === 409 ? "conflict" : code === undefined || code >= 500 ? "unknown" : "rejected");
    } finally { if (requestScope === scope.current) { busy.current = false; setPending(false); } }
  }
  function submit(event: React.FormEvent) {
    event.preventDefault(); if (!ready || !editor || busy.current || version === undefined) return;
    let operationId: string; try { operationId = crypto.randomUUID(); } catch { setNotice("Не удалось подготовить операцию. Обновите страницу."); return; }
    const meta = { operationId, expectedVersion: version };
    if (editor.kind === "create") { if (!name.trim() || name.trim().length > 120) return; void execute({ method: "POST", url: endpoint, body: { name: name.trim(), ...meta } }); }
    else if (editor.kind === "rename") { if (!name.trim() || name.trim().length > 120 || editor.group.archived) return; void execute({ method: "PATCH", url: `${endpoint}/${encodeURIComponent(editor.group.id)}`, body: { kind: "rename", name: name.trim(), ...meta } }); }
    else if (editor.kind === "archive") void execute({ method: "PATCH", url: `${endpoint}/${encodeURIComponent(editor.group.id)}`, body: { kind: "archive", archived: !editor.group.archived, ...meta } });
    else { if (editor.member && currentGroup?.archived) return; void execute({ method: "POST", url: `${endpoint}/${encodeURIComponent(editor.group.id)}/members`, body: { userId: editor.person.id, member: editor.member, ...meta } }); }
  }
  if (forbidden) return null;
  return <div className="min-w-0 space-y-4 p-4 sm:p-6">
    <h1 className="text-xl font-bold break-words sm:text-2xl">Ответственные группы</h1>
    <p className="text-sm text-muted-foreground">Группы независимы от подразделений. Здесь меняется состав группы. Участники получают назначенные группе роли в соответствующих областях; членство само по себе не предоставляет полный доступ. Архивирование сохраняет участников.</p>
    <div className="flex flex-wrap items-end gap-3"><label className="grid gap-1 text-sm">Архив групп<select className="h-10 rounded-md border bg-background px-3" value={archived} disabled={locked} onChange={event => { if (locked || busy.current) return; setArchived(event.target.value); setSelected(null); setQ(""); setSearch(""); resetViews(); }}><option value="all">Все</option><option value="active">Активные</option><option value="archived">Архивные</option></select></label><Button disabled={!ready} onClick={() => open({ kind: "create" })}>Создать группу</Button><Button variant="outline" disabled={locked || fetching} onClick={resetViews}>Обновить списки</Button></div>
    {notice && <p role="status">{notice}</p>}
    {snapshotConflict ? <div role="alert" className="space-y-2"><p>Версии структуры различаются или снимок устарел. Списки скрыты; обновите все данные перед изменением.</p><Button disabled={locked || fetching} onClick={resetViews}>Загрузить актуальные списки</Button></div> : <>
      <Card><CardHeader><CardTitle>Группы</CardTitle></CardHeader><CardContent className="min-w-0"><AdminPagedList query={groups} label="Список групп" blocked={locked} listRef={groupsRef}>{groupRows.map(group => <li key={group.id} className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b p-3"><div className="min-w-0 max-w-full"><Button variant="link" className="h-auto max-w-full whitespace-normal p-0 text-left" disabled={locked} onClick={() => selectGroup(group.id)}><span className="block min-w-0 max-w-full break-all">{group.name}</span></Button><p className="break-all text-xs text-muted-foreground">{group.id} · {group.archived ? "Архивная" : "Активная"}</p></div><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={!ready || group.archived} onClick={() => open({ kind: "rename", group })}>Переименовать</Button><Button variant="outline" size="sm" disabled={!ready} onClick={() => open({ kind: "archive", group })}>{group.archived ? "Восстановить" : "Архивировать"}</Button></div></li>)}</AdminPagedList></CardContent></Card>
      {selected && <>
        {currentGroup && !currentGroup.archived && <GroupLeadershipEditor key={`${actorId}:${currentGroup.id}`} actorId={actorId} groupId={currentGroup.id} disabled={pending || failure !== null || editor !== null || forbidden || snapshotConflict} onBlocked={setLeadershipBlocked} onChanged={resetViews} />}
        <Card><CardHeader><CardTitle className="min-w-0 break-words [overflow-wrap:anywhere]">Состав группы: {currentGroup?.name ?? "загрузка"}</CardTitle><CardDescription>В архивной группе можно удалять участников; добавление недоступно.</CardDescription></CardHeader><CardContent className="min-w-0"><AdminPagedList query={members} label="Состав группы" blocked={locked} listRef={membersRef}>{memberRows.map(person => <li key={person.id} className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b p-3"><PersonLabel person={person} /><Button variant="outline" size="sm" disabled={!ready || !currentGroup} onClick={() => { if (currentGroup) open({ kind: "member", group: currentGroup, person, member: false }); }}>Удалить из группы</Button></li>)}</AdminPagedList></CardContent></Card>
        <Card>
          <CardHeader>
            <CardTitle>Добавить сотрудника</CardTitle>
            <CardDescription>Поиск по имени или ID во всех подразделениях. Список состава может быть неполным; повторное добавление не дублирует членство.</CardDescription>
            <form className="flex min-w-0 flex-wrap gap-2" onSubmit={event => {
              event.preventDefault(); if (locked || busy.current) return;
              resetAdminListQueries(client, [prefix, actorId, "people"]);
              setQ(normalizeAdminSearch(search)); setPeopleEpoch(value => value + 1);
              setEditor(null); setCommand(null); setFailure(null);
            }}>
              <label className="grid w-full min-w-0 basis-full gap-1 text-sm sm:w-auto sm:basis-0 sm:flex-1">Имя или ID<Input className="w-full min-w-0" maxLength={128} value={search} disabled={locked} onChange={event => setSearch(event.target.value)} /></label>
              <Button type="submit" variant="outline" disabled={locked}>Найти</Button>
              <Button type="button" variant="outline" disabled={locked} onClick={() => {
                if (locked || busy.current) return;
                resetAdminListQueries(client, [prefix, actorId, "people"]);
                setSearch(""); setQ(""); setPeopleEpoch(value => value + 1);
                setEditor(null); setFailure(null); setCommand(null);
              }}>Сбросить поиск</Button>
            </form>
          </CardHeader>
          <CardContent className="min-w-0"><AdminPagedList query={people} label="Сотрудники" blocked={locked}>{peopleRows.map(person => <li key={person.id} className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b p-3"><PersonLabel person={person} query={q}/><Button variant="outline" size="sm" disabled={!ready || !currentGroup || currentGroup.archived || loadedMemberIds.has(person.id)} onClick={() => { if (currentGroup) open({ kind: "member", group: currentGroup, person, member: true }); }}>{loadedMemberIds.has(person.id) ? "В загруженном составе" : "Добавить в группу"}</Button></li>)}</AdminPagedList></CardContent>
        </Card>
      </>}
    </>}
    {editor && <div ref={panelRef} tabIndex={-1} role="region" aria-label="Изменение группы" className="space-y-3 rounded-md border p-3"><h2 className="font-semibold">{editor.kind === "create" ? "Новая группа" : editor.kind === "rename" ? "Переименование группы" : editor.kind === "archive" ? editor.group.archived ? "Восстановление группы" : "Архивирование группы" : editor.member ? "Добавление участника" : "Удаление участника"}</h2>{editor.kind !== "create" && <p className="break-all text-sm">{editor.group.name} · {editor.group.id}</p>}{editor.kind === "member" && <PersonLabel person={editor.person} />}
      <form className="space-y-3" onSubmit={submit}>{(editor.kind === "create" || editor.kind === "rename") && <label className="grid gap-1 text-sm">Название группы<Input value={name} required maxLength={120} disabled={locked} onChange={event => setName(event.target.value)} /></label>}
        {failure === "unknown" && <p role="alert">Результат неизвестен: операция могла сохраниться. Повтор отправит те же UUID, параметры и исходную версию.</p>}{failure === "conflict" && <p role="alert">Конфликт версии или ограничений группы. Обновите списки и задайте действие заново; автоматического повтора нет.</p>}{failure === "rejected" && <p role="alert">Изменение отклонено. Проверьте параметры и ограничения группы.</p>}
        <div className="flex flex-wrap gap-2">{failure === "unknown" ? <><Button type="button" disabled={pending} onClick={() => { if (command) void execute(command); }}>Повторить ту же операцию</Button><Button type="button" variant="outline" disabled={pending} onClick={resetViews}>Обновить списки без повтора</Button></> : failure === "conflict" ? <Button type="button" disabled={fetching || pending} onClick={resetViews}>Обновить после конфликта</Button> : <Button type="submit" disabled={!ready}>{pending ? "Сохранение…" : "Сохранить"}</Button>}<Button type="button" variant="outline" disabled={locked} onClick={close}>Закрыть</Button></div>
      </form>
    </div>}
  </div>;
}

function PersonLabel({ person,query }: { person: Person;query?:string }) { return <div className="min-w-0 max-w-full"><p className="break-words [overflow-wrap:anywhere] text-sm"><SearchHighlight text={person.displayName ?? "Имя не указано"} query={query}/></p><p className="break-all text-xs text-muted-foreground">ID: <SearchHighlight text={person.id} query={query}/> · Подразделение: {person.primaryDepartmentId ?? "не назначено"}</p></div>; }
