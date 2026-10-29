import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ user: vi.fn(), create: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/require-api-user', () => ({ requireApiUser: mocks.user }));
vi.mock('@/lib/logger', () => ({ apiLogger: { info: mocks.info, warn: mocks.warn, error: mocks.error } }));
vi.mock('@/lib/organization', () => ({ createOrganizationService: () => ({ createBoard: mocks.create }) }));
import { ConflictError, UnauthorizedError } from '@/lib/errors';
import { POST } from './route';

const body = { name: 'Synthetic board', departmentId: 'dept', responsibleGroupId: null,
  operationId: '11111111-1111-4111-8111-111111111111', expectedVersion: 0 };
const result = { result: { id: 'board', departmentId: 'dept', responsibleGroupId: null }, version: 1, replayed: false };
function request(value: unknown = body, headers: Record<string, string> = {}, query = '') {
  return new Request(`https://app.test/api/organization/projects${query}`, { method: 'POST',
    headers: { origin: 'https://app.test', 'content-type': 'application/json', ...headers }, body: JSON.stringify(value) });
}
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv('TELEMETRY_ENABLED', 'false');
  mocks.user.mockResolvedValue({ id: 'admin', globalRole: 'ADMIN' }); mocks.create.mockResolvedValue(result);
});
afterEach(() => vi.unstubAllEnvs());

describe('audited organization board creation HTTP (mock service)', () => {
  it.each([401, 403])('denies %i before consuming the body', async status => {
    if (status === 401) mocks.user.mockRejectedValue(new UnauthorizedError());
    else mocks.user.mockResolvedValue({ id: 'user', globalRole: 'USER' });
    const input = request(), reader = vi.spyOn(input.body!, 'getReader');
    const response = await POST(input);
    expect(response.status).toBe(status); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(reader).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
  });
  it('uses authenticated identity, closed fields and exact retry metadata', async () => {
    const response = await POST(request({ ...body, name: '  Synthetic board  ' }));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ success: true, data: result });
    expect(mocks.create).toHaveBeenCalledWith({ ...body, actorId: 'admin' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(JSON.stringify(mocks.info.mock.calls)).not.toContain(body.name);
  });
  it.each([
    { ...body, departmentId: null }, { ...body, departmentId: undefined },
    { ...body, departmentId: '../dept' }, { ...body, actorId: 'other' },
    { ...body, globalRole: 'ADMIN' }, { ...body, operationId: undefined },
    { ...body, expectedVersion: -1 }, { ...body, scopes: ['*'] },
  ])('rejects malformed or unauthorized fields without a service call', async value => {
    expect((await POST(request(value))).status).toBe(400); expect(mocks.create).not.toHaveBeenCalled();
  });
  it('rejects unknown query fields before reading a command', async () => {
    expect((await POST(request(body, {}, '?actorId=other'))).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('blocks foreign Origin even with bearer authorization', async () => {
    expect((await POST(request(body, { origin: 'https://foreign.test', authorization: 'Bearer synthetic-token' }))).status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('preserves replay result and maps conflicts to a safe 409', async () => {
    mocks.create.mockResolvedValue({ ...result, replayed: true });
    expect(await (await POST(request())).json()).toEqual({ success: true, data: { ...result, replayed: true } });
    mocks.create.mockRejectedValue(new ConflictError('synthetic-secret'));
    const response = await POST(request()); expect(response.status).toBe(409);
    expect(await response.text()).not.toContain('synthetic-secret');
  });
  it('rejects oversized JSON without creating a board', async () => {
    expect((await POST(request({ ...body, name: 'x'.repeat(17000) }))).status).toBe(413);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
