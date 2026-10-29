"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api';
import type { OrganizationGroupLeadership, OrganizationMutation } from '@/lib/organization-contract';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type Snapshot = { result: OrganizationGroupLeadership; version: number };
type Intent = { operationId: string; expectedVersion: number; userId: string | null };
type Phase = 'idle' | 'pending' | 'unknown' | 'conflict' | 'denied' | 'saved';
function status(error: unknown) {
  return error && typeof error === 'object' && 'status' in error ? error.status : undefined;
}

export default function GroupLeadershipEditor({ groupId, actorId, disabled = false, onBlocked, onChanged }: {
  groupId: string; actorId: string; disabled?: boolean; onBlocked?: (blocked: boolean) => void; onChanged?: () => void;
}) {
  const url = `/api/admin/organization/groups/${encodeURIComponent(groupId)}/leader`;
  const [data, setData] = useState<Snapshot | null>(null), [userId, setUserId] = useState('');
  const [phase, setPhase] = useState<Phase>('idle'), [loading, setLoading] = useState(true), [readError, setReadError] = useState(false);
  const intent = useRef<Intent | null>(null), busy = useRef(false);
  const lifetime = useRef({ generation: 0 }).current;
  const load = useCallback(async () => {
    const scope = ++lifetime.generation;
    setLoading(true); setReadError(false);
    try {
      const snapshot = await apiFetch<Snapshot>(url);
      if (scope !== lifetime.generation) return;
      setData(snapshot); setUserId(snapshot.result.leaderId ?? ''); intent.current = null; setPhase('idle');
    } catch (error) {
      if (scope !== lifetime.generation) return;
      setReadError(true);
      if (status(error) === 401 || status(error) === 403) { setData(null); setUserId(''); }
    } finally { if (scope === lifetime.generation) setLoading(false); }
  }, [url, lifetime]);
  useEffect(() => { setData(null); setUserId(''); intent.current = null; setPhase('idle'); void load(); return () => { lifetime.generation++; }; }, [load, actorId, lifetime]);
  useEffect(() => { onBlocked?.(phase === 'pending' || phase === 'unknown'); }, [phase, onBlocked]);
  useEffect(() => () => onBlocked?.(false), [onBlocked]);
  const send = async (target?: string | null) => {
    if (busy.current || disabled) return;
    if (!intent.current) {
      if (!data || phase !== 'idle' || readError) return;
      intent.current = { operationId: crypto.randomUUID(), expectedVersion: data.version, userId: target === undefined ? userId.trim() : target };
    }
    const scope = lifetime.generation;
    busy.current = true; setPhase('pending'); onBlocked?.(true);
    try {
      const result = await apiFetch<OrganizationMutation<OrganizationGroupLeadership>>(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(intent.current) });
      if (scope !== lifetime.generation) return;
      setData({ result: result.result, version: result.version }); setUserId(result.result.leaderId ?? '');
      intent.current = null; setPhase('saved'); onChanged?.();
    } catch (error) {
      if (scope !== lifetime.generation) return;
      const code = status(error);
      if (code === 401 || code === 403) { setData(null); setUserId(''); intent.current = null; setPhase('denied'); }
      else if (code === 400 || code === 404 || code === 409) setPhase('conflict');
      else setPhase('unknown');
    } finally { busy.current = false; }
  };
  const editable = !disabled && !loading && !readError && data !== null && phase === 'idle';
  return <section aria-label="Руководитель ответственной группы" className="space-y-3 rounded-md border p-3">
    <h2 className="font-semibold">Руководитель ответственной группы</h2>
    <p className="text-sm text-muted-foreground">Укажите ID действующего участника этой группы. Эта настройка не меняет глобальную роль пользователя.</p>
    {data && <p className="break-all text-sm">Текущий руководитель: {data.result.leaderId ?? 'не назначен'}</p>}
    {loading && <p role="status">Загрузка руководителя…</p>}
    {readError && <p role="alert">Не удалось загрузить руководителя. Проверьте доступ и повторите загрузку.</p>}
    <label className="grid gap-1 text-sm">ID руководителя<Input value={userId} disabled={!editable} maxLength={128} onChange={event => setUserId(event.target.value)} /></label>
    <div className="flex flex-wrap gap-2">
      <Button disabled={!editable || !/^[A-Za-z0-9_-]{1,128}$/.test(userId.trim())} onClick={() => void send()}>Назначить руководителя</Button>
      <Button variant="outline" disabled={!editable || data?.result.leaderId === null} onClick={() => void send(null)}>Снять руководителя</Button>
      <Button variant="outline" disabled={disabled || phase === 'pending' || loading} onClick={() => { if (!busy.current) void load(); }}>Загрузить руководителя</Button>
      {phase === 'unknown' && <Button disabled={disabled} onClick={() => void send()}>Повторить ту же операцию</Button>}
    </div>
    {phase === 'pending' && <p role="status">Сохранение…</p>}
    {phase === 'unknown' && <p role="alert">Результат неизвестен. Повтор сохранит исходные UUID, версию и пользователя; загрузка только прочитает данные.</p>}
    {phase === 'conflict' && <p role="alert">Изменение отклонено или структура изменилась. Загрузите актуального руководителя перед новой командой.</p>}
    {phase === 'denied' && <p role="alert">Нет доступа к настройке руководителя.</p>}
    {phase === 'saved' && <p role="status">Руководитель сохранён. Загрузите данные перед новым изменением.</p>}
  </section>;
}
