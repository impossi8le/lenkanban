import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ auth: vi.fn(), read: vi.fn(), write: vi.fn(), log: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/require-api-user', () => ({ requireApiUser: mocks.auth }));
vi.mock('@/lib/logger', () => ({ apiLogger: { info: mocks.log, warn: mocks.log, error: mocks.log } }));
vi.mock('@/lib/organization', () => ({ createOrganizationService: () => ({ setGroupLeader: mocks.write }) }));
vi.mock('@/lib/organization-reader', () => ({ createOrganizationReader: () => ({ groupLeadership: mocks.read }) }));
import { ConflictError, UnauthorizedError } from '@/lib/errors';
import { GET, PUT } from './route';
const body = { operationId: '11111111-1111-4111-8111-111111111111', expectedVersion: 0, userId: 'member' };
const context = () => ({ params: Promise.resolve({ id: 'group' }) });
const request = (value: unknown = body, origin: string | null = 'https://app.test') => new Request('https://app.test/api/admin/organization/groups/group/leader', {
  method: 'PUT', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(value),
});
beforeEach(() => {
  vi.resetAllMocks();
  for (const name of ['NEXT_PUBLIC_APP_URL', 'APP_URL', 'NEXTAUTH_URL']) vi.stubEnv(name, undefined);
  vi.stubEnv('TELEMETRY_ENABLED', 'false');
  mocks.auth.mockResolvedValue({ id: 'admin', globalRole: 'ADMIN' });
  mocks.read.mockResolvedValue({ result: { id: 'group', leaderId: null }, version: 0 });
  mocks.write.mockResolvedValue({ result: { id: 'group', leaderId: 'member' }, version: 1, replayed: false });
});
afterEach(() => vi.unstubAllEnvs());
describe('group leader administrative boundary', () => {
  it('returns the minimized versioned snapshot with no-store', async () => {
    const response = await GET(new Request('https://app.test/api/admin/organization/groups/group/leader'), context());
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ success: true, data: { result: { id: 'group', leaderId: null }, version: 0 } });
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith({ actorId: 'admin', groupId: 'group' });
  });
  it.each(['member', null])('passes only authenticated actor and strict assignment %s', async userId => {
    expect((await PUT(request({ ...body, userId }), context())).status).toBe(200);
    expect(mocks.write).toHaveBeenCalledExactlyOnceWith({ actorId: 'admin', groupId: 'group', ...body, userId });
  });
  it.each([{ ...body, actorId: 'forged' }, { ...body, globalRole: 'ADMIN' }, { ...body, userId: '' }, { ...body, expectedVersion: -1 }])('rejects invalid or forged authority %#', async value => {
    expect((await PUT(request(value), context())).status).toBe(400); expect(mocks.write).not.toHaveBeenCalled();
  });
  it.each(['https://foreign.test', null])('denies foreign/missing Origin before writing %s', async origin => {
    expect((await PUT(request(body, origin), context())).status).toBe(403); expect(mocks.write).not.toHaveBeenCalled();
  });
  it('authenticates and requires ADMIN before body/service', async () => {
    mocks.auth.mockRejectedValueOnce(new UnauthorizedError());
    expect((await PUT(request(), context())).status).toBe(401);
    mocks.auth.mockResolvedValue({ id: 'user', globalRole: 'USER' });
    expect((await PUT(request(), context())).status).toBe(403); expect(mocks.write).not.toHaveBeenCalled();
  });
  it('preserves version conflict without exposing provider details', async () => {
    mocks.write.mockRejectedValue(new ConflictError('synthetic-private-secret'));
    const response = await PUT(request(), context());
    expect(response.status).toBe(409); expect(await response.text()).not.toContain('synthetic-private-secret');
  });
});
