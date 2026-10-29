import { afterEach, expect, it, vi } from 'vitest';
import { emitUserRequestQueueInvalidation } from './board-events';
const logger = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/logger', () => ({ socketLogger: logger }));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('sends only an empty invalidation through the existing authenticated bridge', async () => {
  vi.stubEnv('INTERNAL_EMIT_SECRET', 'synthetic-queue-contract-only-test-secret');
  vi.stubEnv('SOCKET_PORT', '3556');
  const fetch = vi.fn(async () => ({ ok: true }));
  vi.stubGlobal('fetch', fetch);
  await emitUserRequestQueueInvalidation('actor');
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, options] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('http://127.0.0.1:3556/internal/emit');
  expect(JSON.parse(options.body as string)).toEqual({ event: 'request:queue:invalidated', roomId: 'user:actor', data: {} });
  expect(options.headers).toHaveProperty('Authorization');
  await emitUserRequestQueueInvalidation('actor/foreign');
  expect(fetch).toHaveBeenCalledTimes(1);
});
