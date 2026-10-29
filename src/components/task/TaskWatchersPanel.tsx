"use client";
import {SearchHighlight} from "@/components/ui/SearchHighlight";

import { useContext, useEffect, useRef, useState } from "react";
import { QueryClientContext, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Users } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Props = { taskId: string; projectId: string; actorId?: string; onChanged?: () => void; disabled?: boolean };
type Watchers = { items: Array<{ userId: string; name?: string | null }>; canManage?: boolean };
type Candidates = { users: Array<{ id: string; name: string | null; departmentName?: string | null }>; groups: Array<{ id: string; name: string; memberCount: number }> };

export function TaskWatchersPanel(props: Props) {
  const client = useContext(QueryClientContext);
  if (!client || !props.actorId) return null;
  return <WatchersContent key={`${props.actorId}:${props.taskId}`} {...props} actorId={props.actorId} />;
}

function WatchersContent({ taskId, projectId, actorId, onChanged, disabled = false }: Props & { actorId: string }) {
  const client = useQueryClient();
  const endpoint = `/api/tasks/${encodeURIComponent(taskId)}/messages/watchers`;
  const watcherKey = ["task-watchers", actorId, taskId];
  const candidatePrefix = ["task-watcher-candidates", actorId, taskId];
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [users, setUsers] = useState<string[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const alive = useRef(true), pending = useRef(false);
  const changed = useRef(onChanged); changed.current = onChanged;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const queryKey of [["task-watchers", actorId, taskId], ["task-watcher-candidates", actorId, taskId]]) {
        void client.cancelQueries({ queryKey }); client.removeQueries({ queryKey });
      }
    };
  }, [actorId, taskId, client]);
  useEffect(() => { const timer = setTimeout(() => setDebounced(search), 200); return () => clearTimeout(timer); }, [search]);
  const watchers = useQuery({ queryKey: watcherKey, queryFn: ({ signal }) => apiFetch<Watchers>(endpoint, { signal, cache: "no-store" }), staleTime: 0, refetchOnMount: "always", retry: false });
  const fresh = !watchers.isFetching && !watchers.isError && Boolean(watchers.data);
  const watcherCount = fresh && Array.isArray(watchers.data?.items) ? watchers.data.items.length : null;
  const canManage = !watchers.isError && watchers.data?.canManage === true && (fresh || pending.current);
  const candidates = useQuery({ queryKey: [...candidatePrefix, debounced], queryFn: ({ signal }) => apiFetch<Candidates>(`${endpoint}?view=candidates&search=${encodeURIComponent(debounced)}`, { signal, cache: "no-store" }), enabled: open && canManage, staleTime: 0, refetchOnMount: "always", retry: false });
  const freshCandidates = search === debounced && !candidates.isFetching && !candidates.isError;
  async function refresh() {
    await Promise.allSettled([
      client.invalidateQueries({ queryKey: watcherKey }), client.invalidateQueries({ queryKey: ["task-lifecycle", taskId, actorId] }),
      client.invalidateQueries({ queryKey: ["task", taskId] }), client.invalidateQueries({ queryKey: ["my-task-details", actorId, projectId, taskId] }),
      client.invalidateQueries({ queryKey: ["tasks", projectId] }), client.invalidateQueries({ queryKey: ["my-tasks", actorId] }),
      client.invalidateQueries({ queryKey: ["activities", taskId] }),
    ]);
    if (alive.current) await Promise.resolve(changed.current?.());
  }
  async function mutate(method: "POST" | "DELETE", payload: { userIds: string[]; groupIds: string[] } | { userId: string }) {
    if (!canManage || disabled || pending.current) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const result = await apiFetch<{ added?: number; addedCount?: number }>(endpoint, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!alive.current) return;
      await refresh();
      if (!alive.current) return;
      if (method === "POST") { const count = result.addedCount ?? result.added; setNotice(typeof count === "number" ? `Добавлено наблюдателей: ${count}.` : "Наблюдатели добавлены."); setOpen(false); setUsers([]); setGroups([]); setSearch(""); }
      else setNotice("Наблюдатель убран.");
    } catch {
      if (alive.current) { setError("Не удалось сохранить наблюдателей. Выбор сохранён: попробуйте ещё раз. Можно добавить не более 200 человек за один раз."); await refresh(); }
    } finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  function toggle(id: string, kind: "user" | "group") {
    const values = kind === "user" ? users : groups, setter = kind === "user" ? setUsers : setGroups;
    setter(values.includes(id) ? values.filter(value => value !== id) : [...values, id]);
  }
  return <section aria-label="Наблюдатели" className="task-watchers-panel min-w-0 rounded-xl border bg-card" aria-busy={busy || watchers.isFetching}>
    <details className="group">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <Users className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <h3 className="min-w-0 flex-1 text-sm font-medium">Наблюдатели</h3>
        {watcherCount !== null ? (
          <span className="rounded-md bg-muted px-2 py-0.5 text-xs tabular-nums" aria-label={`Доступных наблюдателей: ${watcherCount}`}>{watcherCount}</span>
        ) : (
          <span className="text-xs text-muted-foreground">{watchers.isError ? "Не удалось загрузить" : "Загрузка…"}</span>
        )}
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="space-y-3 border-t p-4">
    <p className="text-sm text-muted-foreground">Видят обращение и могут найти его в поиске. Не становятся исполнителями.</p>
    {watchers.isFetching && <p role="status" className="text-sm text-muted-foreground">Загрузка наблюдателей…</p>}
    {watchers.isError && <div role="alert"><p>Не удалось загрузить наблюдателей.</p><Button className="min-h-12" variant="outline" onClick={() => void watchers.refetch()}>Повторить загрузку наблюдателей</Button></div>}
    {fresh && <ul className="space-y-2">{watchers.data?.items?.map(watcher => <li key={watcher.userId} className="flex min-h-12 flex-wrap items-center justify-between gap-2"><span>{watcher.name || "Сотрудник"}</span>{canManage && <Button className="min-h-12" variant="outline" aria-label={`Убрать наблюдателя ${watcher.name || "Сотрудник"}`} disabled={disabled || busy} onClick={() => void mutate("DELETE", { userId: watcher.userId })}>Убрать</Button>}</li>)}</ul>}
    {fresh && !watchers.data?.items?.length && <p className="text-sm text-muted-foreground">Наблюдателей пока нет.</p>}
    {canManage && <Button className="min-h-12" variant="outline" disabled={disabled || busy} onClick={() => { setOpen(true); setError(""); }}>Добавить наблюдателей</Button>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {error && !open && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </div>
    </details>
    <Dialog open={open && canManage} onOpenChange={value => { if (!pending.current) setOpen(value); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto" onEscapeKeyDown={event => { if (pending.current) event.preventDefault(); }} onPointerDownOutside={event => { if (pending.current) event.preventDefault(); }}>
        <DialogHeader><DialogTitle>Добавить наблюдателей</DialogTitle><DialogDescription>Выберите сотрудников или группы. За один раз — до 100 сотрудников, 20 групп и 200 человек с учётом групп.</DialogDescription></DialogHeader>
        <Tabs defaultValue="users" className="min-w-0 space-y-3">
          <TabsList aria-label="Кого добавить в наблюдатели" className="grid h-auto w-full grid-cols-2">
            <TabsTrigger value="users" disabled={busy} className="min-h-12">Сотрудники</TabsTrigger>
            <TabsTrigger value="groups" disabled={busy} className="min-h-12">Группы</TabsTrigger>
          </TabsList>
        <label className="block space-y-2"><span className="text-sm font-medium">Найти сотрудников или группы</span><Input className="min-h-12" value={search} onChange={event => setSearch(event.target.value.slice(0, 200))} maxLength={200} disabled={busy} /></label>
        {(!freshCandidates || candidates.isPending) && !candidates.isError && <p role="status">Поиск сотрудников и групп…</p>}
        {candidates.isError && <div role="alert"><p>Не удалось загрузить сотрудников и группы.</p><Button className="min-h-12" variant="outline" onClick={() => void candidates.refetch()}>Повторить поиск</Button></div>}
        {freshCandidates && candidates.data && <>
          <TabsContent value="users"><fieldset disabled={busy} className="space-y-2"><legend className="font-semibold">Сотрудники</legend>{candidates.data.users.map(person => <label key={person.id} className="flex min-h-12 items-center gap-3 rounded-lg border px-3 py-2"><input type="checkbox" className="h-5 w-5 shrink-0" aria-label={`${person.name || "Сотрудник"}${person.departmentName ? ` — ${person.departmentName}` : ""}`} checked={users.includes(person.id)} disabled={!users.includes(person.id) && users.length >= 100} onChange={() => toggle(person.id, "user")} /><span><SearchHighlight text={person.name || "Сотрудник"} query={debounced}/>{person.departmentName && <span className="block text-sm text-muted-foreground"><SearchHighlight text={person.departmentName} query={debounced}/></span>}</span></label>)}{!candidates.data.users.length && <p className="text-sm text-muted-foreground">Сотрудники не найдены.</p>}</fieldset></TabsContent>
          <TabsContent value="groups"><fieldset disabled={busy} className="space-y-2"><legend className="font-semibold">Группы</legend><p className="text-sm text-muted-foreground">Добавятся текущие сотрудники группы. Новые участники автоматически доступ не получат.</p>{candidates.data.groups.map(group => <label key={group.id} className="flex min-h-12 items-center gap-3 rounded-lg border px-3 py-2"><input type="checkbox" className="h-5 w-5 shrink-0" aria-label={`${group.name} — сотрудников: ${group.memberCount}`} checked={groups.includes(group.id)} disabled={!groups.includes(group.id) && groups.length >= 20} onChange={() => toggle(group.id, "group")} /><span><SearchHighlight text={group.name} query={debounced}/><span className="block text-sm text-muted-foreground">Сотрудников: {group.memberCount}</span></span></label>)}{!candidates.data.groups.length && <p className="text-sm text-muted-foreground">Группы не найдены.</p>}</fieldset></TabsContent>
        </>}
        </Tabs>
        <p className="text-sm text-muted-foreground">Выбрано сотрудников: {users.length}, групп: {groups.length}.</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter><Button className="min-h-12" variant="outline" disabled={busy} onClick={() => setOpen(false)}>Отмена</Button><Button className="min-h-12" disabled={busy || disabled || !canManage || users.length + groups.length === 0} onClick={() => void mutate("POST", { userIds: users, groupIds: groups })}>{busy ? "Сохраняем…" : "Добавить выбранных"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </section>;
}
