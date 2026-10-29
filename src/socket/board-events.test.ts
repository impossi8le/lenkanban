import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  emitTaskCreated,
  emitTaskUpdated,
  emitTaskMessageCreated,
  emitTaskMoved,
  emitTaskDeleted,
  emitColumnCreated,
  emitColumnUpdated,
  emitColumnDeleted,
  emitColumnsReordered,
  emitProjectMembersUpdated,
  emitProjectMemberDeleted,
} from './board-events';
import type { MoveTaskResponse } from '@/features/kanban/server/move-contract';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/logger', () => ({ socketLogger: mockLogger }));

const SECRET = 'worker-test-secret';
const fetchMock = vi.fn();

const movedFixture: MoveTaskResponse = {
  operationId: '30dc9a4d-3fdc-4f04-b5db-604b4d4c6b93',
  boardRevision: 5,
  task: { id: 't1', columnId: 'c1', version: 1, status: 'TODO' },
};

beforeEach(() => {
  vi.stubEnv('INTERNAL_EMIT_SECRET', SECRET);
  vi.stubEnv('SOCKET_PORT', '3556');
  fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200 } as Response);
  vi.stubGlobal('fetch', fetchMock);
  mockLogger.warn.mockReset();
  mockLogger.error.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('board-events', () => {
  it('sends committed HTTP comments through the authenticated existing bridge', async () => {
    const message = { id: 'm1', taskId: 't1', authorId: 'u1', author: {id: 'u1'}, contentText: 'Synthetic answer', attachments: [], visibility: 'PUBLIC', isInternal: false };
    await emitTaskMessageCreated('p1', message);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({event: 'message:new', roomId: 'project:p1', data: message});
  });
  it('preserves exact wire payloads for all wrappers', async () => {
    const check = (expectedEvent: string, expectedData: unknown) => {
      const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
      const body = JSON.parse(lastCall[1].body as string);
      expect(body).toEqual({ event: expectedEvent, roomId: 'project:p1', data: expectedData });
    };
    emitTaskCreated('p1', { id: 't1' }); check('task:created', { id: 't1' });
    emitTaskUpdated('p1', { id: 't2' }); check('task:updated', { id: 't2' });
    await emitTaskMoved('p1', movedFixture); check('task:moved', movedFixture);
    emitTaskDeleted('p1', 't3', 'u1'); check('task:deleted', { projectId: 'p1', taskId: 't3', deletedById: 'u1' });
    emitColumnCreated('p1', { id: 'c1', name: 'C1' }, 'u2'); check('column:created', { id: 'c1', name: 'C1', createdById: 'u2' });
    emitColumnUpdated('p1', { id: 'c2', name: 'C2' }, 'u3'); check('column:updated', { id: 'c2', name: 'C2', updatedById: 'u3' });
    emitColumnDeleted('p1', 'col1', 'u4'); check('column:deleted', { projectId: 'p1', columnId: 'col1', userId: 'u4' });
    emitColumnsReordered('p1', [{ id: 'c1' }, { id: 'c2' }]); check('columns:reordered', [{ id: 'c1' }, { id: 'c2' }]);
    emitProjectMembersUpdated('p1', { id: 'm1', userId: 'u1' }); check('project:members:updated', { id: 'm1', userId: 'u1' });
    emitProjectMemberDeleted('p1', 'm2'); check('project:member:deleted', { projectId: 'p1', memberId: 'm2' });
  });

  it('sends valid bearer secret header', async () => {
    await emitTaskMoved('p1', movedFixture);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:3556/internal/emit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
      body: expect.any(String),
      signal: expect.any(AbortSignal),
    });
  });

  it('missing or blank secret prevents fetch and logs safe event', () => {
    vi.stubEnv('INTERNAL_EMIT_SECRET', '');
    emitTaskCreated('p1', { id: 't1' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith({ event: 'internal_emit_secret_missing' });
  });

  it('preserves success on 401 or 500 status and logs safe error', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 } as Response);
    await expect(emitTaskMoved('p1', movedFixture)).resolves.toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ event: 'internal_emit_failed' }));
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 } as Response);
    await expect(emitTaskMoved('p1', movedFixture)).resolves.toBeUndefined();
  });

  it('handles fetch reject and logger crash without unhandled errors', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Network failure'));
    mockLogger.error.mockImplementationOnce(() => { throw new Error('Logger blowup'); });
    await expect(emitTaskMoved('p1', movedFixture)).resolves.toBeUndefined();
  });

  it('prevents fetch on cyclic payload and invalid project room', () => {
    const cyclic: Record<string, unknown> = { id: 't1' }; cyclic.self = cyclic;
    emitTaskCreated('p1', cyclic);
    emitTaskCreated('', { id: 't1' });
    emitTaskCreated('bad project!', { id: 't1' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ignores malicious port env and protects fixed host and path', async () => {
    vi.stubEnv('SOCKET_PORT', 'attacker.com:9999/malicious');
    await emitTaskMoved('p1', movedFixture);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:3556/internal/emit', expect.any(Object));
  });

  it('does not leak secret, title, or email in any log call', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 } as Response);
    await emitTaskMoved('p1', movedFixture);
    const logs = JSON.stringify([...mockLogger.warn.mock.calls, ...mockLogger.error.mock.calls]);
    expect(logs).not.toContain(SECRET);
    expect(logs).not.toContain('Task Title');
    expect(logs).not.toContain('dev@test.local');
  });
});
