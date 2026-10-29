"use client";
import {SearchHighlight} from "@/components/ui/SearchHighlight";

import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";

type Person = { id: string; name: string; departmentName?: string };
type Stored = { key: string; people: Person[] };

export function mentionSendErrorCopy(error: unknown): string {
  const value = error && typeof error === "object" ? error as { message?: unknown; payload?: { code?: unknown; error?: { code?: unknown } } } : undefined;
  const code = value?.payload?.error?.code ?? value?.payload?.code ?? value?.message;
  if (code === "MENTION_RECIPIENT_UNAVAILABLE") return "Не удалось отправить сообщение: доступ одного из выбранных сотрудников изменился. Уберите его из упоминаний или выберите заново. Текст сообщения сохранён.";
  if (code === "MENTIONS_INTERNAL_UNSUPPORTED") return "Упоминания пока недоступны во внутренних сообщениях. Выберите обычное сообщение или уберите упоминания. Текст сообщения сохранён.";
  if (code === "Message confirmation timed out") return "Сервер не подтвердил отправку. Текст и выбранные упоминания сохранены. Проверьте переписку и попробуйте повторить отправку.";
  if (code === "Send disconnected" || code === "Чат не подключен" || code === "SocketConnectionFailed") return "Нет соединения с обсуждением. Текст и выбранные упоминания сохранены. Дождитесь подключения и повторите отправку.";
  return "Не удалось отправить сообщение. Текст и выбранные упоминания сохранены. Проверьте соединение и попробуйте ещё раз.";
}

export function useComposerMentions(actorId: string | undefined, taskId: string, text: string, setText: (text: string) => void, allowed = true, focusComposer?: () => void) {
  const key = JSON.stringify([actorId, taskId]);
  const storageKey = `lenkanban:chat-mentions:v1:${key}`;
  const [selection, setSelection] = useState<Stored>({ key: "", people: [] });
  const [storageError, setStorageError] = useState(false);
  const [picker, setPicker] = useState<{ key: string; search: string; start: number | null } | null>(null);
  const [debounced, setDebounced] = useState({ key: "", search: "" });
  const [active, setActive] = useState(0);
  const listId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const dismissedTrigger = useRef<{ key: string; start: number } | null>(null);
  const people = selection.key === key ? selection.people : [];
  const open = Boolean(allowed && actorId && picker?.key === key);
  const search = open ? picker!.search : "";
  useEffect(() => { if (open && picker?.start === null) searchRef.current?.focus(); }, [open, picker?.start]);

  useEffect(() => {
    setPicker(null); setStorageError(false);
    if (!actorId) { setSelection({ key, people: [] }); return; }
    try {
      const raw: unknown = JSON.parse(window.sessionStorage.getItem(storageKey) ?? "[]");
      if (!Array.isArray(raw) || raw.length > 20 || raw.some(p => !p || typeof p.id !== "string" || !p.id || p.id.length > 200 || typeof p.name !== "string" || p.name.length > 200)) throw new Error("Invalid draft");
      setSelection({ key, people: raw.filter((person, index) => raw.findIndex(other => other.id === person.id) === index) });
    } catch { setSelection({ key, people: [] }); setStorageError(true); }
  }, [actorId, key, storageKey]);
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => { setDebounced({ key, search }); setActive(0); }, 200);
    return () => clearTimeout(timer);
  }, [open, key, search]);

  const ready = open && debounced.key === key && debounced.search === search;
  const candidates = useQuery({
    queryKey: ["task-mention-candidates", actorId, taskId, debounced.search],
    enabled: Boolean(ready), staleTime: 0, gcTime: 0, retry: false,
    refetchOnMount: "always",
    queryFn: ({ signal }) => apiFetch<{ items: Person[] }>(`/api/tasks/${taskId}/messages/mention-candidates?search=${encodeURIComponent(debounced.search)}`, { signal, cache: "no-store" }),
  });
  const items = ready && !candidates.isFetching && Array.isArray(candidates.data?.items)
    ? candidates.data.items.filter(p => p && typeof p.id === "string" && typeof p.name === "string") : [];
  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, active, listId]);
  const save = (next: Person[]) => {
    setSelection({ key, people: next });
    try { if (next.length) window.sessionStorage.setItem(storageKey, JSON.stringify(next)); else window.sessionStorage.removeItem(storageKey); }
    catch { setStorageError(true); }
  };
  const choose = (person: Person) => {
    if (!people.some(p => p.id === person.id) && people.length >= 20) return;
    save(people.some(p => p.id === person.id) ? people : [...people, person]);
    const start = picker?.start;
    setText(start == null ? `${text}${text && !text.endsWith(" ") ? " " : ""}@${person.name} ` : `${text.slice(0, start)}@${person.name} ${text.slice(start + search.length + 1)}`);
    setPicker(null);
    focusComposer?.();
  };
  const dismiss = () => {
    if (picker?.start != null) dismissedTrigger.current = { key, start: picker.start };
    setPicker(null);
    focusComposer?.();
  };
  const change = (value: string, cursor: number) => {
    const prefix = value.slice(0, cursor);
    const match = /(?:^|\s)@([^@\n]{0,200})$/.exec(prefix);
    if (!match) { dismissedTrigger.current = null; setPicker(null); return; }
    const start = cursor - match[1].length - 1;
    // A completed explicit mention is ordinary message text from here on.
    // Escape suppresses its trigger until that @ is removed or another is typed.
    if ((dismissedTrigger.current?.key === key && dismissedTrigger.current.start === start)
      || people.some(person => match[1].startsWith(`${person.name} `))) { setPicker(null); return; }
    setPicker({ key, search: match[1], start });
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open || event.nativeEvent.isComposing || event.keyCode === 229) return false;
    if (event.key === "Escape") { event.preventDefault(); dismiss(); return true; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); setActive(previous => items.length ? (previous + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length : 0); return true;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault(); if (!event.repeat && items[active]) choose(items[active]); return true;
    }
    return false;
  };
  const controls = <Popover open={open} onOpenChange={next => { if (!next) { if (picker?.start != null) dismissedTrigger.current = { key, start: picker.start }; setPicker(null); } }}><div className="min-w-0 space-y-2 pt-2">
    <PopoverAnchor asChild><button type="button" disabled={!allowed || !actorId} className="min-h-12 rounded-md border px-3 text-sm disabled:opacity-50" onClick={() => setPicker({ key, search: "", start: null })} aria-expanded={open} aria-controls={open ? listId : undefined}>Упомянуть человека</button></PopoverAnchor>
    {!allowed && <p className="text-sm text-muted-foreground">Упоминания доступны в обычном сообщении. Для внутреннего сообщения уберите выбранные упоминания.</p>}
    <p className="text-sm text-muted-foreground">Упомянуть можно только тех, у кого уже есть доступ к обращению. @ не открывает доступ и не назначает исполнителя.</p>
    {open && <p className="text-sm text-muted-foreground">Если нужного человека нет, начните вводить имя.</p>}
    {text.includes("@") && !people.length && <p className="text-sm text-muted-foreground">В тексте есть @, но получатели не выбраны. Выберите человека, чтобы отправить уведомление.</p>}
    {storageError && <p role="status" className="text-sm text-destructive">Не удалось восстановить или сохранить упоминания. Проверьте получателей и выберите их заново перед отправкой.</p>}
    {people.length > 0 && <div aria-label="Получатели упоминаний" className="flex flex-wrap gap-2">{people.map(person => <button key={person.id} type="button" className="min-h-12 max-w-full break-words rounded-md border px-3 text-sm" aria-label={`Убрать упоминание: ${person.name}`} onClick={() => save(people.filter(p => p.id !== person.id))}>{person.name} ×</button>)}</div>}
    {people.length >= 20 && <p role="status">Можно упомянуть не более 20 сотрудников.</p>}
    <PopoverContent side="top" align="start" collisionPadding={12} aria-label="Выбор человека для упоминания" className="z-[70] max-h-[min(70dvh,var(--radix-popover-content-available-height))] w-[min(28rem,calc(100vw-1.5rem))] max-w-[95vw] overflow-y-auto p-3" onOpenAutoFocus={event => { event.preventDefault(); if (picker?.start === null) searchRef.current?.focus(); }} onCloseAutoFocus={event => event.preventDefault()} onEscapeKeyDown={event => { event.preventDefault(); dismiss(); }}>
      <label className="block text-sm">Имя сотрудника<input ref={searchRef} aria-label="Найти человека для упоминания" aria-controls={listId} aria-activedescendant={items[active] ? `${listId}-${active}` : undefined} value={search} maxLength={200} className="mt-1 min-h-12 w-full rounded-md border bg-background px-3" onChange={e => setPicker({ key, search: e.target.value, start: null })} onKeyDown={e => {
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === "Escape") { e.preventDefault(); dismiss(); }
        if (e.key === "Enter") { e.preventDefault(); if (!e.repeat && items[active]) choose(items[active]); }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setActive(previous => items.length ? (previous + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length : 0); }
      }} /></label>
      {(!ready || candidates.isFetching || candidates.isPending) && <p role="status">Ищем сотрудников с доступом…</p>}
      {ready && candidates.isError && <p role="alert">Не удалось загрузить сотрудников. Попробуйте ещё раз.<button type="button" className="min-h-12 px-3 underline" onClick={() => void candidates.refetch()}>Повторить</button></p>}
      {ready && !candidates.isFetching && !candidates.isPending && !candidates.isError && !items.length && <p role="status">Среди сотрудников с доступом никого не найдено. Проверьте имя. Если нужен другой сотрудник, добавьте его в наблюдатели или обратитесь к автору, исполнителю или руководителю.</p>}
      <div id={listId} role="listbox" aria-label="Сотрудники с доступом" className="max-h-64 overflow-y-auto">{items.map((person, index) => <button key={person.id} id={`${listId}-${index}`} type="button" role="option" aria-selected={active === index} disabled={people.length >= 20 && !people.some(p => p.id === person.id)} className={`block min-h-12 w-full break-words rounded px-3 text-left text-sm ${active === index ? "bg-accent" : ""}`} onClick={() => choose(person)}><SearchHighlight text={person.name} query={debounced.search}/>{person.departmentName && <span className="block text-muted-foreground"><SearchHighlight text={person.departmentName} query={debounced.search}/></span>}</button>)}</div>
      <button type="button" className="min-h-12 px-3 underline" onClick={dismiss}>Закрыть выбор</button>
    </PopoverContent>
  </div></Popover>;
  return { people, clear: () => save([]), controls, change, onKeyDown, listId: open ? listId : undefined, activeId: open && items[active] ? `${listId}-${active}` : undefined };
}
