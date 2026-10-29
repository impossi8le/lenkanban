"use client";
import {SearchHighlight} from "@/components/ui/SearchHighlight";

import * as React from "react";
import { useSession } from "next-auth/react";
import { useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { normalizeAdminSearch, resetAdminListQueries, uniqueById, useAdminPager } from "@/components/admin/admin-list";
import type { OrganizationRoleUser, OrganizationRolePage, OrganizationMutation } from "@/lib/organization-contract";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

type Intent = { userId: string; displayName: string | null; currentRole: "USER" | "ADMIN"; globalRole: "USER" | "ADMIN"; expectedVersion: number };
type Command = { intent: Intent; operationId: string; actionId: string };
const prefix = "adminRoles", wrap = "h-auto min-h-11 max-w-full whitespace-normal break-all";
function status(error: unknown): number | undefined { try { return error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : undefined; } catch { return undefined; } }
function denied(error: unknown) { return status(error) === 401 || status(error) === 403; }

export default function RoleManager({ actorId, initialUserId = "" }: { actorId: string; initialUserId?: string }) {
  const { data: session, status: sessionStatus } = useSession();
  const client = useQueryClient();
  const [accessLost, setAccessLost] = React.useState(false);
  const matching = sessionStatus === "authenticated" && session?.user?.id === actorId && session.user.globalRole === "ADMIN";
  React.useEffect(() => {
    if (accessLost || (sessionStatus !== "loading" && !matching)) { void client.cancelQueries({ queryKey: [prefix, actorId] }); resetAdminListQueries(client, [prefix, actorId]); }
    return () => { void client.cancelQueries({ queryKey: [prefix, actorId] }); resetAdminListQueries(client, [prefix, actorId]); };
  }, [actorId, client, accessLost, matching, sessionStatus]);
  if (sessionStatus === "loading") return <p role="status" className="p-4">Проверка учётной записи…</p>;
  if (!matching || accessLost) return <div role="alert" className="space-y-3 p-4"><p>Учётная запись или права изменились. Данные ролей скрыты.</p><Button className={wrap} onClick={() => window.location.reload()}>Обновить страницу</Button></div>;
  return <Browser key={actorId} actorId={actorId} initialUserId={initialUserId} onDenied={() => setAccessLost(true)} />;
}

function Browser({ actorId, initialUserId, onDenied }: { actorId: string; initialUserId: string; onDenied: () => void }) {
  const client = useQueryClient();
  const [search, setSearch] = React.useState(initialUserId), [q, setQ] = React.useState(initialUserId.toLowerCase()), [epoch, setEpoch] = React.useState(0);
  const [intent, setIntent] = React.useState<Intent | null>(null), [command, setCommand] = React.useState<Command | null>(null);
  const [pending, setPending] = React.useState(false), [failure, setFailure] = React.useState<"unknown" | "conflict" | "rejected" | null>(null), [notice, setNotice] = React.useState("");
  const busy = React.useRef(false), scope = React.useRef(0), restoreFocus = React.useRef(false);
  const listRef = React.useRef<HTMLDivElement>(null), panelRef = React.useRef<HTMLDivElement>(null), moreRef = React.useRef<HTMLButtonElement>(null), triggerRef = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => () => { scope.current++; }, []);
  const query = useAdminPager<OrganizationRoleUser, OrganizationRolePage>({ key: [prefix, actorId, q, epoch], url: "/api/admin/organization/roles", params: q ? { q } : {} });
  const forbidden = denied(query.error);
  React.useEffect(() => { if (forbidden) onDenied(); }, [forbidden, onDenied]);
  const version = query.data?.pages[0]?.version;
  const mismatch = status(query.error) === 409 || !!query.data?.pages.some(page => page.version !== version);
  const locked = pending || failure === "unknown", blocked = locked || failure === "conflict";
  const ready = !forbidden && !mismatch && !blocked && Number.isSafeInteger(version) && !!query.data && !query.isFetching && !query.isError;
  const rows = uniqueById(query.data?.pages.flatMap(page => page.items) ?? []);
  const staleIntent = !!intent && intent.expectedVersion !== version;
  React.useEffect(() => { if (restoreFocus.current && query.data && !query.isFetching && !mismatch && !forbidden) { restoreFocus.current = false; listRef.current?.focus(); } }, [query.data, query.isFetching, mismatch, forbidden]);
  function reload() { if (busy.current) return; restoreFocus.current = true; resetAdminListQueries(client, [prefix, actorId]); setIntent(null); setCommand(null); setFailure(null); setEpoch(value => value + 1); }
  function searchUsers(value: string) { if (blocked || busy.current) return; resetAdminListQueries(client, [prefix, actorId]); setQ(normalizeAdminSearch(value)); setEpoch(value => value + 1); setIntent(null); setCommand(null); setFailure(null); }
  function open(user: OrganizationRoleUser) {
    if (!ready || version === undefined || user.id === actorId && user.globalRole === "ADMIN") return;
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setIntent({ userId: user.id, displayName: user.displayName, currentRole: user.globalRole, globalRole: user.globalRole === "USER" ? "ADMIN" : "USER", expectedVersion: version });
    setCommand(null); setFailure(null); setNotice(""); setTimeout(() => panelRef.current?.focus(), 0);
  }
  function close() { if (blocked || busy.current) return; setIntent(null); setCommand(null); setFailure(null); triggerRef.current?.focus(); }
  async function execute(next: Command) {
    if (busy.current) return;
    busy.current = true; setPending(true); setCommand(next); setFailure(null); const requestScope = scope.current;
    try {
      const result = await apiFetch<OrganizationMutation<{ id: string; globalRole: "USER" | "ADMIN" }>>(`/api/admin/users/${encodeURIComponent(next.intent.userId)}`, { method: "PATCH", headers: { "Content-Type": "application/json", "X-Action-Id": next.actionId }, body: JSON.stringify({ globalRole: next.intent.globalRole, operationId: next.operationId, expectedVersion: next.intent.expectedVersion }) });
      if (requestScope !== scope.current) return;
      setIntent(null); setCommand(null); setNotice(result.replayed ? "Ранее сохранённая операция подтверждена. Обновляем данные." : "Роль сохранена. Обновляем данные.");
      try {
        // Role changes invalidate the versioned cursor chain. Keep the first
        // server-read page for error recovery, then fetch a fresh first page.
        await client.cancelQueries({ queryKey: [prefix, actorId] });
        if (requestScope !== scope.current) return;
        client.setQueriesData<{ pages: OrganizationRolePage[]; pageParams: (string | null)[] }>(
          { queryKey: [prefix, actorId] },
          data => data ? { ...data, pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) } : data,
        );
        await Promise.all([
          client.invalidateQueries({ queryKey: [prefix, actorId] }),
          client.resetQueries({ queryKey: ["adminUsers"] }),
        ]);
        if (requestScope === scope.current) setNotice("Изменение подтверждено. Проверьте актуальный список ниже.");
      }
      catch { if (requestScope === scope.current) setNotice("Изменение сохранено, но перечитать данные не удалось. Обновите список."); }
      if (requestScope === scope.current) listRef.current?.focus();
    } catch (error) { if (requestScope !== scope.current) return; if (denied(error)) { onDenied(); return; } const code = status(error); setFailure(code === 409 ? "conflict" : code === undefined || code >= 500 ? "unknown" : "rejected"); }
    finally { if (requestScope === scope.current) { busy.current = false; setPending(false); } }
  }
  function confirm(event: React.FormEvent) { event.preventDefault(); if (!ready || !intent || staleIntent || busy.current) return; try { void execute({ intent, operationId: crypto.randomUUID(), actionId: crypto.randomUUID() }); } catch { setNotice("Не удалось подготовить операцию. Обновите страницу."); } }
  async function load(retry = false) { if (query.isFetching || blocked) return; const result = retry && !query.isFetchNextPageError ? await query.refetch() : await query.fetchNextPage({ cancelRefetch: false }); if (!result.isError) setTimeout(() => { if (!moreRef.current?.disabled) moreRef.current?.focus(); if (moreRef.current?.disabled || document.activeElement !== moreRef.current) listRef.current?.focus(); }, 0); }
  if (forbidden) return null;
  return <div className="min-w-0 space-y-4 p-4 sm:p-6">
    <h1 className="text-xl font-bold break-words sm:text-2xl">Глобальные роли</h1><p>ADMIN получает широкий глобальный доступ к управлению системой. USER не имеет этих административных прав. Проверяйте пользователя перед подтверждением.</p><p className="text-sm text-muted-foreground">Собственную роль ADMIN понизить нельзя. Имена и состав каталога могут изменяться отдельно; после сохранения данные перечитываются.</p>
    <Button className={wrap} variant="outline" disabled={locked || query.isFetching} onClick={reload}>Обновить все данные</Button>{notice && <p role="status">{notice}</p>}
    {mismatch ? <div role="alert" className="space-y-2"><p>Версии страниц различаются или снимок устарел. Данные скрыты до обновления.</p><Button className={wrap} disabled={locked || query.isFetching} onClick={reload}>Загрузить актуальный список</Button></div> : <fieldset aria-label="Выбор роли" disabled={blocked} className="min-w-0 space-y-4"><Card><CardHeader><CardTitle>Пользователи</CardTitle><form className="flex min-w-0 flex-wrap gap-2" onSubmit={event => { event.preventDefault(); searchUsers(search); }}><label className="grid w-full min-w-0 basis-full gap-1 text-sm sm:w-auto sm:basis-0 sm:flex-1">Имя или ID пользователя<Input className="w-full min-w-0" maxLength={128} value={search} onChange={event => setSearch(event.target.value)} /></label><Button className={wrap} type="submit" variant="outline">Найти</Button><Button className={wrap} type="button" variant="outline" onClick={() => { setSearch(""); searchUsers(""); }}>Сбросить поиск</Button></form></CardHeader><CardContent className="min-w-0 space-y-3">
      {query.isPending && <p role="status">Загрузка пользователей…</p>}{query.isError && <div role="alert" className="space-y-2"><p>Не удалось загрузить пользователей. {query.data ? "Ранее загруженные строки сохранены." : "Попробуйте ещё раз."}</p><Button className={wrap} variant="outline" disabled={query.isFetching || blocked} onClick={() => void load(true)}>Повторить загрузку</Button></div>}
      {query.data && <><div ref={listRef} tabIndex={-1} aria-label="Пользователи" className="max-w-full overflow-x-auto rounded-md border"><ul>{rows.map(row => <li key={row.id} className="min-w-0 space-y-2 border-b p-3"><p className="break-all font-medium"><SearchHighlight text={row.displayName ?? "Без имени"} query={q}/></p><p className="break-all text-sm">ID: <SearchHighlight text={row.id} query={q}/> · Текущая роль: {row.globalRole}</p><Button className={wrap} variant="outline" disabled={!ready || row.id === actorId && row.globalRole === "ADMIN"} onClick={() => open(row)}>Изменить роль {row.id}</Button></li>)}</ul>{rows.length === 0 && !query.isError && <p className="p-3">Ничего не найдено.</p>}</div><Button ref={moreRef} className={wrap} variant="outline" disabled={!query.hasNextPage || query.isFetching || blocked} onClick={() => void load()}>{query.isFetchingNextPage ? "Загрузка…" : query.hasNextPage ? "Загрузить ещё" : "Всё загружено"}</Button></>}
    </CardContent></Card></fieldset>}
    {intent && <div ref={panelRef} tabIndex={-1} role="region" aria-label="Подтверждение глобальной роли" className="min-w-0 space-y-3 rounded-md border p-3"><h2 className="font-semibold">Смена глобальной роли</h2><p className="break-all">Пользователь: {intent.displayName ?? "Без имени"} · {intent.userId}</p><p>Текущая роль: {intent.currentRole}</p><p>Новая роль: {intent.globalRole}</p>{intent.globalRole === "ADMIN" && <p>Подтверждение предоставит широкий глобальный доступ к управлению системой.</p>}<p>Версия подтверждения: {intent.expectedVersion}</p>{staleIntent && failure !== "unknown" && <p role="alert">Данные изменились после открытия подтверждения. Обновите список или закройте форму и задайте действие заново.</p>}{failure === "unknown" && <p role="alert">Результат неизвестен. Повтор отправит ту же роль и исходную версию.</p>}{failure === "conflict" && <p role="alert">Конфликт версии или ограничений. Новые действия заблокированы до явного обновления данных.</p>}{failure === "rejected" && <p role="alert">Изменение отклонено. Проверьте ограничения глобальных ролей.</p>}<form onSubmit={confirm} className="flex flex-wrap gap-2">{failure === "unknown" ? <><Button className={wrap} type="button" disabled={pending} onClick={() => { if (command) void execute(command); }}>Повторить ту же операцию</Button><Button className={wrap} type="button" variant="outline" disabled={pending} onClick={reload}>Обновить без повтора</Button></> : failure === "conflict" ? <Button className={wrap} type="button" disabled={pending || query.isFetching} onClick={reload}>Обновить после конфликта</Button> : <Button className={wrap} type="submit" disabled={!ready || staleIntent}>{pending ? "Сохранение…" : "Подтвердить"}</Button>}<Button className={wrap} type="button" variant="outline" disabled={blocked} onClick={close}>Закрыть</Button></form></div>}
  </div>;
}
