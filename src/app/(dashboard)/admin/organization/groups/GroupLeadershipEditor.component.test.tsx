import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/lib/api', () => ({ apiFetch: mocks.api }));
import GroupLeadershipEditor from './GroupLeadershipEditor';
const snapshot = { result: { id: 'group', leaderId: 'old-member' }, version: 4 };
function mount() { const changed = vi.fn(), blocked = vi.fn(); render(<GroupLeadershipEditor actorId="admin" groupId="group" onChanged={changed} onBlocked={blocked} />); return { changed, blocked }; }
async function choose() {
  await screen.findByText('Текущий руководитель: old-member');
  fireEvent.change(screen.getByLabelText('ID руководителя'), { target: { value: 'member' } });
  fireEvent.click(screen.getByRole('button', { name: 'Назначить руководителя' }));
}
const writes = () => mocks.api.mock.calls.filter(([, options]) => options?.method === 'PUT');
beforeEach(() => {
  vi.resetAllMocks(); mocks.api.mockImplementation(async (_url, options) => options?.method === 'PUT'
    ? { result: { id: 'group', leaderId: 'member' }, version: 5, replayed: false } : snapshot);
});
afterEach(() => cleanup());

describe('separate group leadership command editor', () => {
  it('submits the exact versioned member command and waits for authoritative reload', async () => {
    const { changed } = mount(); await choose();
    await screen.findByText(/Руководитель сохранён/);
    const body = JSON.parse(writes()[0][1].body);
    expect(body).toEqual({ operationId: expect.any(String), expectedVersion: 4, userId: 'member' });
    expect(changed).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Назначить руководителя' })).toBeDisabled();
  });
  it('clears leadership with null instead of removing membership', async () => {
    mount(); await screen.findByText('Текущий руководитель: old-member');
    fireEvent.click(screen.getByRole('button', { name: 'Снять руководителя' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(JSON.parse(writes()[0][1].body).userId).toBeNull();
  });
  it('retries an uncertain response with identical intent, then performs reads only after success', async () => {
    let attempt = 0;
    mocks.api.mockImplementation(async (_url, options) => {
      if (options?.method !== 'PUT') return snapshot;
      if (++attempt === 1) throw new TypeError('synthetic network failure');
      return { result: { id: 'group', leaderId: 'member' }, version: 5, replayed: true };
    });
    mount(); await choose();
    fireEvent.click(await screen.findByRole('button', { name: 'Повторить ту же операцию' }));
    await screen.findByText(/Руководитель сохранён/);
    expect(writes()).toHaveLength(2); expect(writes()[1][1].body).toBe(writes()[0][1].body);
    fireEvent.click(screen.getByRole('button', { name: 'Загрузить руководителя' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Назначить руководителя' })).toBeEnabled());
    expect(writes()).toHaveLength(2);
  });
  it('keeps refresh failure recoverable after a rejected command', async () => {
    let reads = 0;
    mocks.api.mockImplementation(async (_url, options) => {
      if (options?.method === 'PUT') throw { status: 409 };
      if (++reads > 1) throw { status: 503 };
      return snapshot;
    });
    const { blocked } = mount(); await choose();
    await screen.findByText(/Изменение отклонено/);
    fireEvent.click(screen.getByRole('button', { name: 'Загрузить руководителя' }));
    await screen.findByText(/Не удалось загрузить руководителя/);
    expect(screen.getByRole('button', { name: 'Загрузить руководителя' })).toBeEnabled();
    expect(blocked).toHaveBeenLastCalledWith(false);
    expect(writes()).toHaveLength(1);
  });
  it('blocks duplicate commands while a request is pending', async () => {
    let resolve!: (value: unknown) => void;
    mocks.api.mockImplementation((_url, options) => options?.method === 'PUT' ? new Promise(done => { resolve = done; }) : Promise.resolve(snapshot));
    const { blocked } = mount(); await choose();
    expect(screen.getByRole('button', { name: 'Снять руководителя' })).toBeDisabled();
    expect(blocked).toHaveBeenLastCalledWith(true); expect(writes()).toHaveLength(1);
    await act(async () => resolve({ result: { id: 'group', leaderId: 'member' }, version: 5, replayed: false }));
  });
  it('hides cached leadership after access revocation and never sends a replacement command', async () => {
    mocks.api.mockImplementation(async (_url, options) => { if (options?.method === 'PUT') throw { status: 403 }; return snapshot; });
    mount(); await choose(); await screen.findByText('Нет доступа к настройке руководителя.');
    expect(screen.queryByText('Текущий руководитель: old-member')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Назначить руководителя' })).toBeDisabled();
    expect(writes()).toHaveLength(1);
  });
});
