import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  user: vi.fn(), create: vi.fn(), list: vi.fn(), revoke: vi.fn(), find: vi.fn(), rate: vi.fn(),
  info: vi.fn(), warn: vi.fn(), error: vi.fn(),
}));
vi.mock('@/lib/prisma', () => ({ prisma: { apiToken: {
  create: mocks.create, findMany: mocks.list, updateMany: mocks.revoke, findFirst: mocks.find,
} } }));
vi.mock('@/lib/require-user', () => ({ requireDbUser: mocks.user }));
vi.mock('@/lib/rate-limit', () => ({ rateLimitOrThrow: mocks.rate,
  rateLimitErrorResponse: () => new Response('{}', { status: 429 }) }));
vi.mock('@/lib/logger', () => ({ apiLogger: { info: mocks.info, warn: mocks.warn, error: mocks.error } }));
import { UnauthorizedError } from '@/lib/errors';
import { hashApiToken, parseApiToken } from '@/lib/api-tokens';
import { GET, POST } from './route';
import { DELETE } from './[id]/route';

const origin = 'https://app.test';
function request(method = 'POST', body: unknown = { name: 'synthetic-label' }, headers: Record<string, string> = {}) {
  return new Request(`${origin}/api/tokens`, { method,
    headers: { origin, 'content-type': 'application/json', ...headers },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
}
const revoke = (input = request('DELETE'), id = 'token-id') => DELETE(input, { params: Promise.resolve({ id }) });
const logs = () => JSON.stringify([mocks.info.mock.calls, mocks.warn.mock.calls, mocks.error.mock.calls]);
beforeEach(() => {
  for (const name of ['NEXT_PUBLIC_APP_URL', 'APP_URL', 'NEXTAUTH_URL']) vi.stubEnv(name, undefined);
  vi.resetAllMocks(); vi.stubEnv('TELEMETRY_ENABLED', 'false');
  mocks.user.mockResolvedValue({ id: 'actor', globalRole: 'USER' });
  mocks.create.mockResolvedValue({ id: 'token-id', name: 'synthetic-label', createdAt: '2026-10-21T00:00:00Z' });
  mocks.list.mockResolvedValue([]); mocks.revoke.mockResolvedValue({ count: 1 });
});
afterEach(() => vi.unstubAllEnvs());

describe('cookie token management transport', () => {
  it('issues a token for configured public Origin behind an internal proxy URL', async () => {
    vi.stubEnv('NEXTAUTH_URL', origin);
    const input = new Request('http://localhost:3000/api/tokens', {
      method: 'POST', headers: { origin, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ name: 'synthetic-label' }),
    });
    expect((await POST(input)).status).toBe(201);
    expect(mocks.create).toHaveBeenCalledOnce();
  });
  it('rejects a foreign Origin behind a proxy even with spoofed forwarding headers', async () => {
    vi.stubEnv('NEXTAUTH_URL', origin);
    const input = new Request('http://localhost:3000/api/tokens', {
      method: 'POST', headers: { origin: 'https://foreign.test', 'x-forwarded-host': 'foreign.test', 'x-forwarded-proto': 'https', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'synthetic-label' }),
    });
    expect((await POST(input)).status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each([GET, POST, revoke])('authenticates before body, parameters and persistence', async handler => {
    mocks.user.mockRejectedValue(new UnauthorizedError());
    const input = request(); const reader = vi.spyOn(input.body!, 'getReader');
    const response = await handler(input);
    expect(response.status).toBe(401); expect(reader).not.toHaveBeenCalled();
    expect(mocks.rate).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.revoke).not.toHaveBeenCalled();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });
  it.each([POST, revoke])('rejects foreign Origin, cross-site and bearer cookie-waiver attempts', async handler => {
    const foreign = request('POST', {}, { origin: 'https://foreign.test' });
    const crossSite = request('POST', {}, { 'sec-fetch-site': 'cross-site' });
    const missing = request('POST', {}, { authorization: 'Bearer synthetic-secret' });
    missing.headers.delete('origin');
    for (const input of [foreign, crossSite, missing]) expect((await handler(input)).status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.revoke).not.toHaveBeenCalled();
    expect(logs()).not.toContain('synthetic-secret');
  });
  it('returns plaintext once with no-store and persists only the hash', async () => {
    const response = await POST(request());
    expect(response.status).toBe(201); expect(response.headers.get('cache-control')).toBe('no-store');
    const { data } = await response.json();
    expect(parseApiToken(data.token)).not.toBeNull();
    expect(mocks.create).toHaveBeenCalledWith({ data: {
      userId: 'actor', name: 'synthetic-label', tokenHash: hashApiToken(data.token),
      scopes: [], expiresAt: null,
    }, select: { id: true, name: true, createdAt: true } });
    expect(logs()).not.toContain(data.token); expect(logs()).not.toContain('synthetic-label');
    expect(JSON.stringify(mocks.create.mock.calls)).not.toContain(data.token);
  });
  it.each([
    { name: 'label', scopes: ['organization.write'] },
    { name: 'label', expiresAt: '2000-01-01T00:00:00Z' },
    { name: 'label', expiresAt: 'invalid' },
    { name: 'label', expiresAt: '2030-01-01' },
    { name: 'label', expiresAt: 1893456000000 },
    { name: 'label', userId: 'other' },
    { name: 'label', nested: { secret: 'synthetic-secret' } },
  ])('rejects unsupported authority/expiry rather than issuing an unrestricted token', async body => {
    const response = await POST(request('POST', body));
    expect(response.status).toBe(400); expect(mocks.create).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain('synthetic-secret');
    expect(logs()).not.toContain('synthetic-secret');
  });
  it('bounds JSON size and rejects malformed JSON/media before issuing a credential', async () => {
    expect((await POST(request('POST', { name: 'x'.repeat(17000) }))).status).toBe(413);
    const bad = new Request(`${origin}/api/tokens`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{' });
    expect((await POST(bad)).status).toBe(400);
    expect((await POST(request('POST', {}, { 'content-type': 'text/plain' }))).status).toBe(415);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('does not issue on limiter errors and preserves 429', async () => {
    mocks.rate.mockRejectedValueOnce(Object.assign(new Error('synthetic-secret'), { status: 429 }));
    const limited = await POST(request()); expect(limited.status).toBe(429);
    expect(limited.headers.get('cache-control')).toBe('no-store');
    mocks.rate.mockRejectedValueOnce(new Error('synthetic-secret'));
    const failed = await POST(request()); expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain('synthetic-secret');
    expect(mocks.create).not.toHaveBeenCalled(); expect(logs()).not.toContain('synthetic-secret');
  });
  it('lists only the authenticated owner and excludes token hashes', async () => {
    const item = { id: 'token-id', name: 'label', scopes: ['request.update'], expiresAt: '2030-01-01T00:00:00.000Z' };
    mocks.list.mockResolvedValue([item]);
    const response = await GET(request('GET'));
    expect(response.status).toBe(200);
    expect((await response.json()).data.items).toEqual([item]);
    expect(mocks.list).toHaveBeenCalledWith({ where: { userId: 'actor' }, orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, createdAt: true, lastUsedAt: true, revokedAt: true, scopes: true, expiresAt: true } });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it.each([
    { scopes: [] },
    { scopes: ['request.read', 'request.create', 'request.update', 'request.move', 'request.comment',
      'request.attachment.read', 'request.export', 'board.create', 'board.columns.manage',
      'board.members.manage', 'board.privileges.manage'] },
  ])('persists the requested scopes and future expiry: %j', async ({ scopes }) => {
    const expiresAt = '2030-01-01T00:00:00.000Z';
    const response = await POST(request('POST', { name: 'label', scopes, expiresAt }));
    expect(response.status).toBe(201);
    expect(mocks.create.mock.calls[0][0].data).toMatchObject({ scopes, expiresAt: new Date(expiresAt) });
  });
  it('rejects an expiry equal to the current instant', async () => {
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now);
    expect((await POST(request('POST', { name: 'label', expiresAt: new Date(now).toISOString() }))).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('atomically binds revocation to owner and unrevoked state', async () => {
    expect((await revoke()).status).toBe(204);
    expect(mocks.revoke).toHaveBeenCalledWith({ where: { id: 'token-id', userId: 'actor', revokedAt: null },
      data: { revokedAt: expect.any(Date) } });
    expect(mocks.find).not.toHaveBeenCalled();
  });
  it('concurrent retries preserve first revokedAt with only one state change (model stub)', async () => {
    let revokedAt: Date | null = null; let writes = 0;
    mocks.revoke.mockImplementation(async ({ data }: { data: { revokedAt: Date } }) => {
      if (revokedAt !== null) return { count: 0 };
      revokedAt = data.revokedAt; writes++; return { count: 1 };
    });
    mocks.find.mockResolvedValue({ id: 'token-id' });
    const first = await revoke(); const original = revokedAt;
    const responses = await Promise.all([revoke(), revoke()]);
    expect([first, ...responses].map(response => response.status)).toEqual([204, 204, 204]);
    expect(writes).toBe(1); expect(revokedAt).toBe(original);
  });
  it('returns the same 404 for missing and foreign credentials', async () => {
    mocks.revoke.mockResolvedValue({ count: 0 }); mocks.find.mockResolvedValue(null);
    expect((await revoke()).status).toBe(404);
    expect(mocks.find).toHaveBeenCalledWith({ where: { id: 'token-id', userId: 'actor' }, select: { id: true } });
  });
  it('rejects invalid token identifiers before a write', async () => {
    expect((await revoke(request('DELETE'), '../synthetic-secret')).status).toBe(400);
    expect(mocks.revoke).not.toHaveBeenCalled(); expect(logs()).not.toContain('synthetic-secret');
  });
  it('reports storage failures as safe 500 rather than an authentication failure', async () => {
    mocks.revoke.mockRejectedValue(new Error('synthetic-secret'));
    const response = await revoke(); expect(response.status).toBe(500);
    expect(response.headers.get('x-error-id')).toBeTruthy();
    expect(await response.text()).not.toContain('synthetic-secret'); expect(logs()).not.toContain('synthetic-secret');
  });
});
