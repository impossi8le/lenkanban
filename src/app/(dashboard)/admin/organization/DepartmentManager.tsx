"use client";

import * as React from "react";
import { useSession } from "next-auth/react";
import { useQueryClient } from "@tanstack/react-query";
import type { OrganizationDepartment, OrganizationDepartmentPage, OrganizationMutation } from "@/lib/organization-contract";
import { apiFetch } from "@/lib/api";
import { resetAdminListQueries, uniqueById, useAdminPager } from "@/components/admin/admin-list";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type MutationResult = OrganizationMutation<OrganizationDepartment>;
type Editor = { kind: "create" } | { kind: "rename" | "move" | "archive"; target: OrganizationDepartment };
type Command = { method: "POST" | "PATCH"; url: string; body: Record<string, string | number | boolean | null> };
type Failure = "unknown" | "conflict" | "rejected" | null;
const prefix = "adminDepartments";
const endpoint = "/api/admin/organization/departments";
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
function status(error: unknown): number | undefined {
  try { return error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : undefined; } catch { return undefined; }
}
function denied(error: unknown) { return status(error) === 401 || status(error) === 403; }

export default function DepartmentManager({ actorId }: { actorId: string }) {
  const { data: session, status: sessionStatus } = useSession();
  const client = useQueryClient();
  const [accessLost, setAccessLost] = React.useState(false);
  const matching = sessionStatus === "authenticated" && session?.user?.id === actorId && session.user.globalRole === "ADMIN";
  React.useEffect(() => {
    if (accessLost || (sessionStatus !== "loading" && !matching)) {
      void client.cancelQueries({ queryKey: [prefix, actorId] });
      resetAdminListQueries(client, [prefix, actorId]);
    }
    return () => { void client.cancelQueries({ queryKey: [prefix, actorId] }); resetAdminListQueries(client, [prefix, actorId]); };
  }, [actorId, client, matching, sessionStatus, accessLost]);
  if (sessionStatus === "loading") return <p role="status" className="p-4">Проверка учётной записи…</p>;
  if (!matching || accessLost) return <div role="alert" className="space-y-3 p-4"><p>Учётная запись или права изменились. Данные подразделений скрыты.</p><Button onClick={() => window.location.reload()}>Обновить страницу</Button></div>;
  return <DepartmentBrowser key={actorId} actorId={actorId} onDenied={() => setAccessLost(true)} />;
}

function DepartmentBrowser({ actorId, onDenied }: { actorId: string; onDenied: () => void }) {
  const client = useQueryClient();
  const [trail, setTrail] = React.useState<{ id: string; name: string }[]>([]);
  const [archived, setArchived] = React.useState("all");
  const [epoch, setEpoch] = React.useState(0);
  const [editor, setEditor] = React.useState<Editor | null>(null);
  const [name, setName] = React.useState("");
  const [parentInput, setParentInput] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [command, setCommand] = React.useState<Command | null>(null);
  const [failure, setFailure] = React.useState<Failure>(null);
  const [notice, setNotice] = React.useState("");
  const busyRef = React.useRef(false);
  const scopeRef = React.useRef(0);
  const listRef = React.useRef<HTMLDivElement>(null);
  const nextRef = React.useRef<HTMLButtonElement>(null);
  const editorRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLElement | null>(null);
  const restoreListFocus = React.useRef(false);
  const parentId = trail.at(-1)?.id ?? null;
  React.useEffect(() => () => { scopeRef.current++; }, []);
  const list = useAdminPager<OrganizationDepartment, OrganizationDepartmentPage>({
    key: [prefix, actorId, parentId, archived, epoch], url: endpoint,
    params: { archived, ...(parentId ? { parentId } : {}) },
  });
  const forbidden = denied(list.error);
  React.useEffect(() => { if (forbidden) onDenied(); }, [forbidden, onDenied]);
  const pages = list.data?.pages;
  const version = pages?.[0]?.version;
  const mixed = !!pages?.some(page => page.version !== version);
  const conflict = status(list.error) === 409 || mixed;
  const rows = React.useMemo(() => uniqueById(pages?.flatMap(page => page.items) ?? []), [pages]);
  const parent = pages?.[0]?.parent;
  // A rejected version stays latched until the explicit refresh clears the
  // editor and removes the old query snapshot; dismiss/navigation cannot do it.
  const locked = pending || failure === "unknown" || failure === "conflict";
  const canMutate = Number.isSafeInteger(version) && !list.isFetching && !list.isError && !conflict && !locked;
  React.useEffect(() => {
    if (restoreListFocus.current && list.data && !list.isFetching && !conflict && !forbidden) {
      restoreListFocus.current = false;
      listRef.current?.focus();
    }
  }, [list.data, list.isFetching, conflict, forbidden]);

  function refresh() {
    if (busyRef.current) return;
    restoreListFocus.current = true;
    resetAdminListQueries(client, [prefix, actorId]);
    setEditor(null); setCommand(null); setFailure(null); setEpoch(value => value + 1);
  }
  function navigate(next: typeof trail) {
    if (locked || busyRef.current) return;
    restoreListFocus.current = true;
    resetAdminListQueries(client, [prefix, actorId]);
    setTrail(next); setEditor(null); setCommand(null); setFailure(null); setNotice(""); setEpoch(value => value + 1);
  }
  function open(next: Editor) {
    if (!canMutate) return;
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditor(next); setName(next.kind === "rename" ? next.target.name : ""); setParentInput(next.kind === "move" ? next.target.parentId ?? "" : ""); setFailure(null); setCommand(null); setNotice("");
    setTimeout(() => editorRef.current?.focus(), 0);
  }
  function close() { if (locked || busyRef.current) return; setEditor(null); setCommand(null); setFailure(null); triggerRef.current?.focus(); }
  async function execute(next: Command) {
    if (busyRef.current) return;
    busyRef.current = true; setPending(true); setCommand(next); setFailure(null);
    const scope = scopeRef.current;
    try {
      const result = await apiFetch<MutationResult>(next.url, { method: next.method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(next.body) });
      if (scope !== scopeRef.current) return;
      setCommand(null); setEditor(null);
      setNotice(result.replayed ? "Ранее сохранённая операция подтверждена. Обновляем список." : "Изменение сохранено. Обновляем список.");
      // No optimistic tree: wait for authoritative reads, preserving old rows if that read fails.
      try {
        await client.invalidateQueries({ queryKey: [prefix, actorId] });
        if (scope === scopeRef.current) setNotice(result.replayed ? "Ранее сохранённая операция подтверждена. Проверьте актуальный список ниже." : "Изменение сохранено. Проверьте актуальный список ниже.");
      } catch {
        if (scope === scopeRef.current) setNotice("Изменение сохранено, но перечитать список не удалось. Обновите список перед следующим действием.");
      }
      if (scope === scopeRef.current) { listRef.current?.focus(); }
    } catch (error) {
      if (scope !== scopeRef.current) return;
      if (denied(error)) { onDenied(); return; }
      const code = status(error);
      setFailure(code === 409 ? "conflict" : code === undefined || code >= 500 ? "unknown" : "rejected");
    } finally {
      if (scope === scopeRef.current) { busyRef.current = false; setPending(false); }
    }
  }
  function submit(event: React.FormEvent) {
    event.preventDefault(); if (!editor || !canMutate || busyRef.current || version === undefined) return;
    let operationId: string;
    try { operationId = crypto.randomUUID(); } catch { setNotice("Не удалось подготовить операцию. Обновите страницу."); return; }
    const meta = { operationId, expectedVersion: version };
    if (editor.kind === "create") {
      if (!name.trim() || name.trim().length > 120 || parent?.archived) return;
      void execute({ method: "POST", url: endpoint, body: { name: name.trim(), parentId, ...meta } });
    } else {
      const url = `${endpoint}/${encodeURIComponent(editor.target.id)}`;
      if (editor.kind === "rename") { if (!name.trim() || name.trim().length > 120) return; void execute({ method: "PATCH", url, body: { kind: "rename", name: name.trim(), ...meta } }); }
      else if (editor.kind === "move") { const target = parentInput.trim(); if (target && !idPattern.test(target)) return; void execute({ method: "PATCH", url, body: { kind: "move", parentId: target || null, ...meta } }); }
      else void execute({ method: "PATCH", url, body: { kind: "archive", archived: !editor.target.archived, ...meta } });
    }
  }
  async function load(retry = false) {
    if (list.isFetching || locked) return;
    const result = retry && !list.isFetchNextPageError ? await list.refetch() : await list.fetchNextPage({ cancelRefetch: false });
    if (!result.isError) setTimeout(() => { if (!nextRef.current?.disabled) nextRef.current?.focus(); if (nextRef.current?.disabled || document.activeElement !== nextRef.current) listRef.current?.focus(); }, 0);
  }
  if (forbidden) return null;
  return <div className="min-w-0 space-y-4 p-4 sm:p-6">
    <h1 className="text-2xl font-bold break-words">Подразделения</h1>
    <p className="text-sm text-muted-foreground">Структура подразделений не выдаёт права на доски и заявки. Архивация сохраняет историю; используемое подразделение архивировать нельзя.</p>
    <nav aria-label="Путь навигации по подразделениям" className="flex min-w-0 flex-wrap items-center gap-2 text-sm"><Button variant="link" className="h-auto p-0" disabled={locked} onClick={() => navigate([])}>Корневые подразделения</Button>{trail.map((item, index) => <React.Fragment key={item.id}><span aria-hidden="true">/</span><Button variant="link" className="h-auto max-w-full whitespace-normal break-words p-0" disabled={locked} aria-current={index === trail.length - 1 ? "page" : undefined} onClick={() => navigate(trail.slice(0, index + 1))}>{index === trail.length - 1 && parent ? parent.name : item.name}</Button></React.Fragment>)}</nav>
    <Card><CardHeader><CardTitle>{parentId ? `Дочерние подразделения: ${parent?.name ?? "загрузка"}` : "Корневые подразделения"}</CardTitle><CardDescription>Показаны непосредственные дочерние узлы. ID родителя для переноса проверяется сервером.</CardDescription><div className="flex flex-wrap items-end gap-3"><label className="grid gap-1 text-sm">Архив<select className="h-10 rounded-md border bg-background px-3" value={archived} disabled={locked} onChange={event => { if (locked || busyRef.current) return; resetAdminListQueries(client, [prefix, actorId]); setArchived(event.target.value); setEpoch(value => value + 1); setEditor(null); setFailure(null); setCommand(null); }}><option value="all">Все</option><option value="active">Активные</option><option value="archived">Архивные</option></select></label><Button disabled={!canMutate || !!parent?.archived} onClick={() => open({ kind: "create" })}>{parentId ? "Создать дочернее" : "Создать подразделение"}</Button><Button variant="outline" disabled={locked || list.isFetching} onClick={refresh}>Обновить список</Button></div></CardHeader><CardContent className="min-w-0 space-y-4">
      {notice && <p role="status">{notice}</p>}
      {list.isPending && <p role="status">Загрузка подразделений…</p>}
      {conflict ? <div role="alert" className="space-y-2"><p>Структура изменилась. Страницы прежнего снимка скрыты. Обновите список перед продолжением.</p><Button disabled={locked || list.isFetching} onClick={refresh}>Загрузить актуальную структуру</Button></div> : <>
        {list.isError && <div role="alert" className="space-y-2"><p>Не удалось загрузить подразделения. {list.data ? "Ранее загруженные строки сохранены." : "Попробуйте ещё раз."}</p><Button variant="outline" disabled={list.isFetching || locked} onClick={() => void load(true)}>Повторить загрузку</Button></div>}
        {list.data && <><div ref={listRef} tabIndex={-1} aria-label="Список подразделений" className="max-w-full overflow-x-auto rounded-md border"><table className="w-full min-w-[620px] text-left text-sm"><thead><tr className="border-b"><th className="p-3">Название</th><th className="p-3">ID</th><th className="p-3">Состояние</th><th className="p-3">Действия</th></tr></thead><tbody>{rows.map(row => <tr key={row.id} className="border-b"><td className="max-w-64 break-words p-3"><Button variant="link" className="h-auto whitespace-normal break-words p-0 text-left" disabled={locked} onClick={() => navigate([...trail, { id: row.id, name: row.name }])}>{row.name}</Button></td><td className="max-w-40 break-all p-3">{row.id}</td><td className="p-3">{row.archived ? "Архивное" : "Активное"}</td><td className="p-3"><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={!canMutate || row.archived} onClick={() => open({ kind: "rename", target: row })}>Переименовать</Button><Button size="sm" variant="outline" disabled={!canMutate || row.archived} onClick={() => open({ kind: "move", target: row })}>Переместить</Button><Button size="sm" variant="outline" disabled={!canMutate} onClick={() => open({ kind: "archive", target: row })}>{row.archived ? "Восстановить" : "Архивировать"}</Button></div></td></tr>)}</tbody></table></div>{rows.length === 0 && !list.isError && <p>Подразделения не найдены.</p>}<Button ref={nextRef} variant="outline" disabled={!list.hasNextPage || list.isFetching || locked} onClick={() => void load()}>{list.isFetchingNextPage ? "Загрузка…" : list.hasNextPage ? "Загрузить ещё" : "Всё загружено"}</Button></>}
      </>}
      {editor && <div ref={editorRef} tabIndex={-1} role="region" aria-label="Изменение подразделения" className="space-y-3 rounded-md border p-3"><h2 className="font-semibold">{editor.kind === "create" ? "Новое подразделение" : editor.kind === "rename" ? "Переименование" : editor.kind === "move" ? "Перемещение" : editor.target.archived ? "Восстановление" : "Архивация"}</h2>{editor.kind !== "create" && <p className="break-all text-sm">{editor.target.name} · {editor.target.id}</p>}
        <form className="space-y-3" onSubmit={submit}>
          {(editor.kind === "create" || editor.kind === "rename") && <label className="grid gap-1 text-sm">Название<Input value={name} required maxLength={120} disabled={locked} onChange={event => setName(event.target.value)} /></label>}
          {editor.kind === "move" && <label className="grid gap-1 text-sm">ID нового родителя (пусто — корень)<Input value={parentInput} maxLength={128} pattern={"[A-Za-z0-9_\\-]*"} disabled={locked} onChange={event => setParentInput(event.target.value)} /></label>}
          {editor.kind === "archive" && <p className="text-sm">{editor.target.archived ? "Восстановление проверит доступность цепочки родителей." : "Сервер проверит отсутствие назначенных сотрудников, привязанных досок и активных дочерних подразделений."}</p>}
          {failure === "unknown" && <p role="alert">Результат неизвестен: операция могла сохраниться. Повтор отправит ту же операцию с исходной версией и параметрами.</p>}
          {failure === "conflict" && <p role="alert">Конфликт версии или ограничений структуры. Автоматического повтора изменения нет. Обновите список, затем задайте действие заново.</p>}
          {failure === "rejected" && <p role="alert">Изменение отклонено. Проверьте параметры и ограничения подразделения.</p>}
          <div className="flex flex-wrap gap-2">{failure === "unknown" ? <><Button type="button" disabled={pending} onClick={() => { if (command) void execute(command); }}>Повторить ту же операцию</Button><Button type="button" variant="outline" disabled={pending} onClick={refresh}>Обновить список без повтора</Button></> : failure === "conflict" ? <Button type="button" disabled={pending || list.isFetching} onClick={refresh}>Обновить после конфликта</Button> : <Button type="submit" disabled={!canMutate}>{pending ? "Сохранение…" : "Сохранить"}</Button>}<Button type="button" variant="outline" disabled={locked} onClick={close}>Закрыть</Button></div>
        </form>
      </div>}
    </CardContent></Card>
  </div>;
}
