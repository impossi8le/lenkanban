"use client";
import {SearchHighlight} from "@/components/ui/SearchHighlight";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type RequestAudienceChoice = { mode: "DEPARTMENT" | "SELECTED" | null; userIds: string[] };
export type RequestRecipient = { id: string; name: string | null };

export function RequestAudienceField({ value, onChange, recipients, loading, error, onRetry, disabled, department }: {
  value: RequestAudienceChoice;
  onChange: (value: RequestAudienceChoice) => void;
  recipients: RequestRecipient[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  disabled: boolean;
  department: string;
}) {
  const id = useId();
  const [search, setSearch] = useState("");
  const visible = recipients.filter(person => (person.name || "Сотрудник").toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return <fieldset disabled={disabled} className="space-y-3 rounded-xl border bg-muted/20 p-4" aria-describedby={`${id}-hint`}>
    <legend className="px-1 font-semibold">Кто увидит обращение</legend>
    <p className="text-muted-foreground">Направление: {department}</p>
    <label className="flex min-h-12 cursor-pointer items-start gap-3 rounded-lg border bg-card p-3">
      <input type="checkbox" className="mt-1" checked={value.mode === "SELECTED"} onChange={event => onChange({ mode: event.target.checked ? "SELECTED" : "DEPARTMENT", userIds: [] })} />
      <span><strong className="block">Персональная заявка</strong><span className="text-muted-foreground">Только выбранным сотрудникам</span></span>
    </label>
    <p id={`${id}-hint`} className="text-muted-foreground">{value.mode === "SELECTED" ? "Персональную заявку увидят вы, выбранные сотрудники, руководитель отдела-получателя и главный администратор системы. Остальные сотрудники не увидят её ни на доске, ни в поиске." : "Общая заявка: её увидит весь отдел-получатель. Чтобы обратиться только к конкретным сотрудникам, поставьте галочку «Персональная заявка»."}</p>
    {value.mode === "SELECTED" && <div className="space-y-3 border-t pt-3">
      <p>Выберите от 1 до 20 сотрудников. Исполнителем станет тот, кто возьмёт обращение в работу.</p>
      {loading ? <p role="status">Загружаем сотрудников отдела…</p> : error ? <div role="alert" className="space-y-2"><p>Не удалось загрузить сотрудников. Отправка пока недоступна.</p><Button type="button" variant="outline" onClick={onRetry}>Загрузить сотрудников ещё раз</Button></div> : <>
        {recipients.length > 0 && <div className="space-y-2"><label htmlFor={`${id}-search`}>Найти сотрудника</label><Input id={`${id}-search`} type="search" placeholder="Введите имя или фамилию" value={search} onChange={event => setSearch(event.target.value)} /></div>}
        <div className="max-h-64 space-y-1 overflow-y-auto" role="group" aria-label="Получатели обращения">
          {visible.map(person => <label key={person.id} className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border bg-card p-3">
            <input type="checkbox" checked={value.userIds.includes(person.id)} disabled={disabled || (!value.userIds.includes(person.id) && value.userIds.length >= 20)} onChange={event => onChange({ mode: "SELECTED", userIds: event.target.checked ? [...value.userIds, person.id] : value.userIds.filter(id => id !== person.id) })} />
            <span><SearchHighlight text={person.name || "Сотрудник"} query={search}/></span>
          </label>)}
          {visible.length === 0 && <p className="text-muted-foreground">{recipients.length === 0 ? "В этом направлении пока нет доступных получателей. Выберите весь отдел или обратитесь к администратору." : "Сотрудник не найден. Измените поиск."}</p>}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2"><p role="status">Выбрано сотрудников: {value.userIds.length}</p>{value.userIds.length > 0 && <Button type="button" variant="outline" onClick={() => onChange({ mode: "SELECTED", userIds: [] })}>Снять выбор</Button>}</div>
      </>}
    </div>}
  </fieldset>;
}
