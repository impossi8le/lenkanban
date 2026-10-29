import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ user: vi.fn(), list: vi.fn(), history: vi.fn(), create: vi.fn(), rename: vi.fn(), move: vi.fn(), archive: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/require-api-user', () => ({ requireApiUser: mocks.user }));
vi.mock('@/lib/logger', () => ({ apiLogger: { info: mocks.info, warn: mocks.warn, error: mocks.error } }));
vi.mock('@/lib/organization-reader', () => ({ createOrganizationReader: () => ({ departments: mocks.list, history: mocks.history }) }));
vi.mock('@/lib/organization', () => ({ createOrganizationService: () => ({ createDepartment: mocks.create, renameDepartment: mocks.rename, moveDepartment: mocks.move, setDepartmentArchived: mocks.archive }) }));
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from '@/lib/errors';
import { GET, POST } from './departments/route';
import { PATCH } from './departments/[id]/route';
import { GET as HISTORY } from './history/route';

const operationId = '11111111-1111-4111-8111-111111111111';
const meta = { operationId, expectedVersion: 3 };
const result = { result: { id: 'dept', name: 'Synthetic department', parentId: null, leaderId: null, archived: false }, version: 4, replayed: false };
function request(path = '/api/admin/organization/departments', body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://app.test${path}`, body === undefined ? { headers } : {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://app.test', ...headers }, body: JSON.stringify(body),
  });
}
const patch = (input: Request) => PATCH(input, { params: Promise.resolve({ id: 'dept' }) });
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv('TELEMETRY_ENABLED', 'false');
  mocks.user.mockResolvedValue({ id: 'actor', globalRole: 'ADMIN' });
  mocks.list.mockResolvedValue({ items: [], parent: null, nextCursor: null, version: 3 });
  mocks.history.mockResolvedValue({ items: [], nextCursor: null });
  for (const fn of [mocks.create, mocks.rename, mocks.move, mocks.archive]) fn.mockResolvedValue(result);
});
afterEach(() => vi.unstubAllEnvs());

describe('ADMIN organization transport (database service independently tested)', () => {
  it.each([GET, HISTORY, POST, patch])('authenticates before reading body and returns no-store401', async handler => {
    mocks.user.mockRejectedValue(new UnauthorizedError());
    const input = request(undefined, { privateValue: 'synthetic-secret' });
    const reader = vi.spyOn(input.body!, 'getReader');
    const response = await handler(input);
    expect(response.status).toBe(401); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(reader).not.toHaveBeenCalled(); expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each([GET, HISTORY, POST, patch])('denies current non-ADMIN before query/body', async handler => {
    mocks.user.mockResolvedValue({ id: 'actor', globalRole: 'USER' });
    const input = request(undefined, {}); const reader = vi.spyOn(input.body!, 'getReader');
    expect((await handler(input)).status).toBe(403); expect(reader).not.toHaveBeenCalled();
    expect(mocks.history).not.toHaveBeenCalled(); expect(mocks.rename).not.toHaveBeenCalled();
  });
  it('passes bounded list parameters and returns server correlation headers', async () => {
    const response = await GET(request('/api/admin/organization/departments?parentId=parent&archived=active&limit=2&cursor=cursor'));
    expect(response.status).toBe(200); expect(response.headers.get('x-request-id')).toBeTruthy();
    expect(mocks.list).toHaveBeenCalledWith({ actorId: 'actor', parentId: 'parent', archived: 'active', limit: 2, cursor: 'cursor' });
  });
  it.each(['?unknown=synthetic-secret', '?limit=101', '?limit=2x', '?archived=invalid', '?parentId=', '?limit=1&limit=2'])('rejects invalid query %s', async query => {
    expect((await GET(request(`/api/admin/organization/departments${query}`))).status).toBe(400);
    expect(mocks.list).not.toHaveBeenCalled(); expect(JSON.stringify(mocks.info.mock.calls)).not.toContain('synthetic-secret');
  });
  it('forwards a strict normalized command with identity only from authenticated actor', async () => {
    const response = await POST(request(undefined, { ...meta, name: '  Synthetic department  ', parentId: null }));
    expect(response.status).toBe(201); expect(await response.json()).toEqual({ success: true, data: result });
    expect(mocks.create).toHaveBeenCalledWith({ actorId: 'actor', ...meta, name: 'Synthetic department', parentId: null });
    expect(JSON.stringify(mocks.info.mock.calls)).not.toContain('Synthetic department');
  });
  it.each([
    { ...meta, name: 'X', parentId: null, actorId: 'other' },
    { ...meta, name: 'X', parentId: null, globalRole: 'ADMIN' },
    { ...meta, name: 'X', parentId: null, expectedVersion: -1 },
    { ...meta, name: 'X', parentId: null, operationId: 'bad' },
    { ...meta, name: 'X', parentId: null, expectedVersion: 2147483648 },
    { name: 'X', parentId: null },
  ])('rejects unauthorized or malformed command fields', async body => {
    expect((await POST(request(undefined, body))).status).toBe(400); expect(mocks.create).not.toHaveBeenCalled();
  });
  it('blocks foreign Origin even for bearer and blocks cookie mutation without Origin', async () => {
    expect((await POST(request(undefined, { ...meta, name: 'X', parentId: null }, { origin: 'https://foreign.test', authorization: 'Bearer synthetic-test-token' }))).status).toBe(403);
    const input = request(undefined, { ...meta, name: 'X', parentId: null }); input.headers.delete('origin');
    expect((await POST(input)).status).toBe(403); expect(mocks.create).not.toHaveBeenCalled();
  });
  it('allows a verified bearer without Origin and preserves exact replay metadata', async () => {
    const input = request(undefined, { ...meta, name: 'X', parentId: null }, { authorization: 'Bearer synthetic-test-token' }); input.headers.delete('origin');
    mocks.create.mockResolvedValue({ ...result, replayed: true });
    expect((await POST(input)).status).toBe(201); expect(mocks.create).toHaveBeenCalledWith({ actorId: 'actor', ...meta, name: 'X', parentId: null });
  });
  it.each([
    [{ kind: 'rename', name: 'New', ...meta }, 'rename', { name: 'New' }],
    [{ kind: 'move', parentId: 'parent', ...meta }, 'move', { parentId: 'parent' }],
    [{ kind: 'archive', archived: true, ...meta }, 'archive', { archived: true }],
  ] as const)('dispatches only the selected command %j', async (body, method, data) => {
    expect((await patch(request(undefined, body))).status).toBe(200);
    expect(mocks[method]).toHaveBeenCalledWith({ actorId: 'actor', departmentId: 'dept', ...meta, ...data });
    expect([mocks.rename, mocks.move, mocks.archive].filter(fn => fn.mock.calls.length)).toHaveLength(1);
  });
  it('rejects mixed command fields and invalid target without invoking writes', async () => {
    expect((await patch(request(undefined, { kind: 'rename', name: 'X', parentId: 'elsewhere', ...meta }))).status).toBe(400);
    expect((await PATCH(request(undefined, { kind: 'rename', name: 'X', ...meta }), { params: Promise.resolve({ id: '../secret' }) })).status).toBe(400);
    expect(mocks.rename).not.toHaveBeenCalled();
  });
  it.each([[new ConflictError(), 409], [new ForbiddenError(), 403], [new NotFoundError(), 404], [new ValidationError(), 400], [new Error('synthetic-private-database-message'), 500]] as const)('maps service failure to fixed safe status %s', async (error, status) => {
    mocks.create.mockRejectedValue(error);
    const response = await POST(request(undefined, { ...meta, name: 'X', parentId: null }));
    expect(response.status).toBe(status); expect(response.headers.get('x-error-id')).toBeTruthy();
    expect(await response.text()).not.toContain('synthetic-private'); expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('uses the shared bounded JSON reader and never invokes service for oversized body', async () => {
    const input = request(undefined, { ...meta, name: 'x'.repeat(17000), parentId: null });
    expect((await POST(input)).status).toBe(413); expect(mocks.create).not.toHaveBeenCalled();
  });
  it('rejects malformed JSON and non-JSON media type without persistence', async () => {
    const invalid = new Request('https://app.test/api/admin/organization/departments', { method: 'POST', headers: { origin: 'https://app.test', 'content-type': 'application/json' }, body: '{' });
    expect((await POST(invalid)).status).toBe(400);
    const wrongType = request(undefined, {}); wrongType.headers.set('content-type', 'text/plain');
    expect((await POST(wrongType)).status).toBe(415); expect(mocks.create).not.toHaveBeenCalled();
  });
  it('exposes bounded history only through the reader with no raw query in technical logs', async () => {
    const response = await HISTORY(request('/api/admin/organization/history?targetId=dept&limit=2&cursor=cursor'));
    expect(response.status).toBe(200); expect(mocks.history).toHaveBeenCalledWith({ actorId: 'actor', targetId: 'dept', limit: 2, cursor: 'cursor' });
    expect(JSON.stringify(mocks.info.mock.calls)).not.toContain('targetId=');
  });
});
