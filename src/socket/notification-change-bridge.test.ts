import { afterEach, expect, it, vi } from 'vitest';
import { emitUserNotificationChanged } from './board-events';
const logger = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/logger', () => ({ socketLogger: logger }));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('sends only an empty invalidation through the existing authenticated bridge', async () => {
  vi.stubEnv('INTERNAL_EMIT_SECRET', 'synthetic-queue-contract-only-test-secret');
  vi.stubEnv('SOCKET_PORT', '3556');
  const fetch = vi.fn(async () => ({ ok: true }));
  vi.stubGlobal('fetch', fetch);
  await emitUserNotificationChanged('actor');
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, options] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('http://127.0.0.1:3556/internal/emit');
  expect(JSON.parse(options.body as string)).toEqual({ event: 'notification:changed', roomId: 'user:actor', data: {version:1} });
  expect(options.headers).toHaveProperty('Authorization');
  await emitUserNotificationChanged('actor/foreign');
  expect(fetch).toHaveBeenCalledTimes(1);
});
