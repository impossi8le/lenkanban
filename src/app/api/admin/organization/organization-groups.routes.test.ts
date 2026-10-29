import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ user: vi.fn(), groups: vi.fn(), members: vi.fn(), people: vi.fn(), create: vi.fn(), rename: vi.fn(), archive: vi.fn(), member: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/require-api-user', () => ({ requireApiUser: mocks.user }));
vi.mock('@/lib/logger', () => ({ apiLogger: { info: mocks.info, warn: mocks.warn, error: mocks.error } }));
vi.mock('@/lib/organization-reader', () => ({ createOrganizationReader: () => ({ groups: mocks.groups, members: mocks.members, people: mocks.people }) }));
vi.mock('@/lib/organization', () => ({ createOrganizationService: () => ({ createGroup: mocks.create, renameGroup: mocks.rename, setGroupArchived: mocks.archive, setGroupMember: mocks.member }) }));
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from '@/lib/errors';
import { GET as GROUPS, POST as CREATE } from './groups/route';
import { PATCH } from './groups/[id]/route';
import { GET as MEMBERS, POST as MEMBER } from './groups/[id]/members/route';
import { GET as PEOPLE } from './people/route';

const meta = { operationId: '11111111-1111-4111-8111-111111111111', expectedVersion: 4 };
const result = { result: { id: 'group1', name: 'Synthetic group', archived: false }, version: 5, replayed: false };
const context = () => ({ params: Promise.resolve({ id: 'group1' }) });
const patch = (request: Request) => PATCH(request, context());
const members = (request: Request) => MEMBERS(request, context());
const member = (request: Request) => MEMBER(request, context());
function request(path = '/api/admin/organization/groups', body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://app.test${path}`, body === undefined ? { headers } : { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://app.test', ...headers }, body: JSON.stringify(body) });
}
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv('TELEMETRY_ENABLED', 'false');
  mocks.user.mockResolvedValue({ id: 'actor', globalRole: 'ADMIN' });
  mocks.groups.mockResolvedValue({ items: [], nextCursor: null, version: 4 });
  mocks.members.mockResolvedValue({ group: result.result, items: [], nextCursor: null, version: 4 });
  mocks.people.mockResolvedValue({ items: [], nextCursor: null, version: 4 });
  for (const fn of [mocks.create, mocks.rename, mocks.archive, mocks.member]) fn.mockResolvedValue(result);
});
afterEach(() => vi.unstubAllEnvs());

it.each([GROUPS, CREATE, patch, members, member, PEOPLE])('denies unauthenticated requests before body/reader/mutations', async handler => {
  mocks.user.mockRejectedValue(new UnauthorizedError());
  const input = request(undefined, { ...meta, name: 'Synthetic secret name' });
  const reader = vi.spyOn(input.body!, 'getReader');
  const response = await handler(input);
  expect(response.status).toBe(401); expect(response.headers.get('cache-control')).toBe('no-store'); expect(reader).not.toHaveBeenCalled();
  for (const fn of [mocks.groups, mocks.members, mocks.people, mocks.create, mocks.rename, mocks.archive, mocks.member]) expect(fn).not.toHaveBeenCalled();
});
it.each([GROUPS, CREATE, patch, members, member, PEOPLE])('denies current non-global-admin before data', async handler => {
  mocks.user.mockResolvedValue({ id: 'actor', globalRole: 'USER' });
  expect((await handler(request(undefined, {}))).status).toBe(403);
  for (const fn of [mocks.groups, mocks.members, mocks.people, mocks.create, mocks.rename, mocks.archive, mocks.member]) expect(fn).not.toHaveBeenCalled();
});
it('does not resolve membership path parameters before authentication', async () => {
  mocks.user.mockRejectedValue(new UnauthorizedError());
  let read = false;
  const params = { then: () => { read = true; throw Error('Should not inspect path'); } } as unknown as Promise<{ id: string }>;
  expect((await MEMBERS(request(), { params })).status).toBe(401); expect(read).toBe(false);
});
it('passes bounded group filters and cursor without logging names/query', async () => {
  expect((await GROUPS(request('/api/admin/organization/groups?archived=archived&limit=3&cursor=cursor'))).status).toBe(200);
  expect(mocks.groups).toHaveBeenCalledWith({ actorId: 'actor', archived: 'archived', limit: 3, cursor: 'cursor' });
  expect(JSON.stringify(mocks.info.mock.calls)).not.toContain('archived=');
});
it.each(['?archived=unknown', '?limit=0', '?limit=101', '?limit=x', '?limit=1&limit=2', '?actorId=other', '?cursor='])('rejects malformed group query %s', async query => {
  expect((await GROUPS(request(`/api/admin/organization/groups${query}`))).status).toBe(400); expect(mocks.groups).not.toHaveBeenCalled();
});
it('forwards minimized people search only to the shared reader, never technical context', async () => {
  const response = await PEOPLE(request('/api/admin/organization/people?q=synthetic-private-search&limit=2&cursor=cursor'));
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
  expect(mocks.people).toHaveBeenCalledWith({ actorId: 'actor', q: 'synthetic-private-search', limit: 2, cursor: 'cursor' });
  expect(JSON.stringify(mocks.info.mock.calls)).not.toContain('synthetic-private-search');
});
it.each(['?q=', '?q=a&q=b', '?globalRole=ADMIN', '?limit=1e2'])('rejects malformed people query %s', async query => {
  expect((await PEOPLE(request(`/api/admin/organization/people${query}`))).status).toBe(400); expect(mocks.people).not.toHaveBeenCalled();
});
it('routes group membership paging to its path group only', async () => {
  expect((await MEMBERS(request('/api/admin/organization/groups/group1/members?limit=2&cursor=cursor'), context())).status).toBe(200);
  expect(mocks.members).toHaveBeenCalledWith({ actorId: 'actor', groupId: 'group1', limit: 2, cursor: 'cursor' });
});
it('creates only with normalized permitted fields and preserves replay metadata', async () => {
  mocks.create.mockResolvedValue({ ...result, replayed: true });
  const response = await CREATE(request(undefined, { name: '  Synthetic group  ', ...meta }));
  expect(response.status).toBe(201); expect(await response.json()).toEqual({ success: true, data: { ...result, replayed: true } });
  expect(mocks.create).toHaveBeenCalledWith({ actorId: 'actor', name: 'Synthetic group', ...meta });
  expect(JSON.stringify(mocks.info.mock.calls)).not.toContain('Synthetic group');
});
it.each([
  { name: 'G', ...meta, actorId: 'other' }, { name: 'G', ...meta, departmentId: 'dept' },
  { name: 'G', ...meta, expectedVersion: -1 }, { name: 'G', ...meta, operationId: 'bad' },
  { name: 'G', ...meta, expectedVersion: 2147483648 }, { name: 'G' }, { name: ' ', ...meta },
])('rejects malformed or privileged group create fields', async body => {
  expect((await CREATE(request(undefined, body))).status).toBe(400); expect(mocks.create).not.toHaveBeenCalled();
});
it.each([
  [{ kind: 'rename', name: ' G ', ...meta }, 'rename', { name: 'G' }],
  [{ kind: 'archive', archived: true, ...meta }, 'archive', { archived: true }],
  [{ kind: 'archive', archived: false, ...meta }, 'archive', { archived: false }],
] as const)('dispatches strict group change %j', async (body, method, data) => {
  expect((await patch(request(undefined, body))).status).toBe(200);
  expect(mocks[method]).toHaveBeenCalledWith({ actorId: 'actor', groupId: 'group1', ...meta, ...data });
  expect([mocks.rename, mocks.archive].filter(fn => fn.mock.calls.length)).toHaveLength(1);
});
it('rejects unknown/mixed group operations', async () => {
  expect((await patch(request(undefined, { kind: 'delete', ...meta }))).status).toBe(400);
  expect((await patch(request(undefined, { kind: 'rename', name: 'G', archived: true, ...meta }))).status).toBe(400);
  expect(mocks.rename).not.toHaveBeenCalled(); expect(mocks.archive).not.toHaveBeenCalled();
});
it.each([true, false])('dispatches audited membership member=%s without adding fields', async flag => {
  expect((await member(request(undefined, { userId: 'person1', member: flag, ...meta }))).status).toBe(200);
  expect(mocks.member).toHaveBeenCalledWith({ actorId: 'actor', groupId: 'group1', userId: 'person1', member: flag, ...meta });
});
it.each([
  { userId: 'person1', member: true, ...meta, globalRole: 'ADMIN' },
  { userId: 'person1', member: true, ...meta, groupId: 'other' },
  { userId: 'person1', member: 'false', ...meta }, { userId: '../bad', member: true, ...meta },
  { userId: 'person1', member: true },
])('rejects malformed membership command', async body => {
  expect((await member(request(undefined, body))).status).toBe(400); expect(mocks.member).not.toHaveBeenCalled();
});
it.each([CREATE, patch, member])('rejects cross-origin or cookie without Origin before persistence', async handler => {
  const input = request(undefined, { ...meta, name: 'G' }, { origin: 'https://foreign.test', authorization: 'Bearer synthetic-token' });
  expect((await handler(input)).status).toBe(403);
  const noOrigin = request(undefined, {}); noOrigin.headers.delete('origin');
  expect((await handler(noOrigin)).status).toBe(403);
  expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.member).not.toHaveBeenCalled();
});
it('allows already verified bearer without Origin for membership command', async () => {
  const input = request(undefined, { userId: 'person1', member: true, ...meta }, { authorization: 'Bearer synthetic-token' }); input.headers.delete('origin');
  expect((await member(input)).status).toBe(200); expect(mocks.member).toHaveBeenCalledOnce();
});
it.each([[new ConflictError('synthetic-private-detail'), 409], [new ForbiddenError(), 403], [new NotFoundError(), 404], [new Error('synthetic-private-detail'), 500]] as const)('maps service failures to fixed safe responses', async (error, status) => {
  mocks.member.mockRejectedValue(error);
  const response = await member(request(undefined, { userId: 'person1', member: true, ...meta }));
  expect(response.status).toBe(status); expect(response.headers.get('x-error-id')).toBeTruthy(); expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.text()).not.toContain('synthetic-private');
});
it('rejects invalid path and oversized body before writes', async () => {
  const invalidContext = { params: Promise.resolve({ id: '../bad' }) };
  expect((await MEMBERS(request(), invalidContext)).status).toBe(400);
  expect((await MEMBER(request(undefined, {}), invalidContext)).status).toBe(400);
  expect((await CREATE(request(undefined, { name: 'x'.repeat(17000), ...meta }))).status).toBe(413);
  expect(mocks.members).not.toHaveBeenCalled(); expect(mocks.member).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
});
