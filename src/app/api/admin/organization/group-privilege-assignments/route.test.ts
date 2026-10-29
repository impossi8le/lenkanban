import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ actor: vi.fn(), list: vi.fn(), delegation: vi.fn(), assign: vi.fn(), log: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/require-api-user', () => ({ requireApiUser: mocks.actor }));
vi.mock('@/lib/logger', () => ({ apiLogger: { info: mocks.log, warn: mocks.log, error: mocks.log } }));
vi.mock('@/lib/organization-reader', () => ({ createOrganizationReader: () => ({ groupPrivilegeAssignments: mocks.list, privilegeDelegationCheck: mocks.delegation }) }));
vi.mock('@/lib/organization', () => ({ createOrganizationService: () => ({ setGroupPrivilegeAssignment: mocks.assign }) }));
import { ConflictError, UnauthorizedError } from '@/lib/errors';
import { GET, POST } from './route';

const url = 'https://app.test/api/admin/organization/group-privilege-assignments';
const body = { groupId: 'group', profileId: 'profile', scopeKind: 'department', departmentId: 'dept', projectId: null,
  assigned: true, operationId: '11111111-1111-4111-8111-111111111111', expectedVersion: 3 };
const request = (value: unknown = body, origin = 'https://app.test') => new Request(url, { method: 'POST', headers: {
  origin, 'content-type': 'application/json',
}, body: JSON.stringify(value) });
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv('TELEMETRY_ENABLED', 'false');
  mocks.actor.mockResolvedValue({ id: 'admin', globalRole: 'ADMIN' });
  mocks.list.mockResolvedValue({ items: [], version: 3, nextCursor: null });
  mocks.assign.mockResolvedValue({ result: { id: 'assignment', ...body }, version: 4, replayed: false });
  mocks.delegation.mockResolvedValue({ allowed: true });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('group role HTTP boundary (mock service, no real DB)', () => {
  it.each([GET, POST])('requires authentication before reading facts or caller body', async handler => {
    mocks.actor.mockRejectedValue(new UnauthorizedError()); const input = request(); const read = vi.spyOn(input.body!, 'getReader');
    const response = await handler(input); expect(response.status).toBe(401); expect(read).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.assign).not.toHaveBeenCalled();
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it.each([GET, POST])('does not turn a group profile into global administration', async handler => {
    mocks.actor.mockResolvedValue({ id: 'ordinary', globalRole: 'USER' });
    expect((await handler(request())).status).toBe(403); expect(mocks.assign).not.toHaveBeenCalled(); expect(mocks.list).not.toHaveBeenCalled();
  });
  it('lists the exact group with bounded pagination and no writes', async () => {
    const response = await GET(new Request(url + '?groupId=group&limit=2&cursor=opaque'));
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.list).toHaveBeenCalledExactlyOnceWith({ actorId: 'admin', groupId: 'group', limit: 2, cursor: 'opaque' });
    expect(mocks.assign).not.toHaveBeenCalled();
  });
  it.each(['', '?groupId=a&groupId=b', '?groupId=../bad', '?groupId=group&limit=101', '?groupId=group&userId=other'])(
    'rejects malformed/untrusted query %s', async query => {
      expect((await GET(new Request(url + query))).status).toBe(400); expect(mocks.list).not.toHaveBeenCalled();
    });
  it.each([
    { ...body, userId: 'other' }, { ...body, actorId: 'other' }, { ...body, permissions: ['request.manage'] },
    { ...body, scopeKind: 'organization' }, { ...body, departmentId: null }, { ...body, expectedVersion: -1 },
    { ...body, groupId: '../bad' }, { ...body, operationId: 'bad' }, { ...body, assigned: 'yes' },
  ])('rejects incomplete scopes and injected authority %#', async value => {
    expect((await POST(request(value))).status).toBe(400); expect(mocks.assign).not.toHaveBeenCalled(); expect(mocks.delegation).not.toHaveBeenCalled();
  });
  it('requires trusted mutation Origin before body processing', async () => {
    const input = request(body, 'https://other.test'), read = vi.spyOn(input.body!, 'getReader');
    expect((await POST(input)).status).toBe(403); expect(read).not.toHaveBeenCalled(); expect(mocks.assign).not.toHaveBeenCalled();
  });
  it('checks delegation before grant and forwards only normalized command fields', async () => {
    expect((await POST(request())).status).toBe(200);
    expect(mocks.delegation).toHaveBeenCalledExactlyOnceWith({ actorId: 'admin', profileId: 'profile',
      scopeKind: 'department', departmentId: 'dept', projectId: null });
    expect(mocks.assign).toHaveBeenCalledExactlyOnceWith({ actorId: 'admin', ...body });
    mocks.assign.mockClear(); mocks.delegation.mockResolvedValue({ allowed: false });
    expect((await POST(request())).status).toBe(403); expect(mocks.assign).not.toHaveBeenCalled();
  });
  it('permits revoke without delegation; preserves conflict and no-store behavior', async () => {
    expect((await POST(request({ ...body, assigned: false }))).status).toBe(200); expect(mocks.delegation).not.toHaveBeenCalled();
    mocks.assign.mockRejectedValue(new ConflictError());
    const response = await POST(request({ ...body, assigned: false }));
    expect(response.status).toBe(409); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });
});
