import { afterEach, expect, it, vi } from 'vitest';

const peers = vi.hoisted(() => [] as Array<{
  handlers: Map<string, () => void>;
  on: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  removeAllListeners: ReturnType<typeof vi.fn>;
}>);
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => {
    const handlers = new Map<string, () => void>();
    const socket = { handlers, on: vi.fn((event: string, handler: () => void) => handlers.set(event, handler)),
      disconnect: vi.fn(), removeAllListeners: vi.fn() };
    peers.push(socket);
    return socket;
  }),
}));

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); peers.length = 0; });

it('discards every transport and the entire document on a point access revoke', async () => {
  const replace = vi.fn();
  vi.stubGlobal('window', { location: { replace } });
  const { createSocketConnection, getSocketInstance } = await import('../lib/socket-client');
  createSocketConnection();
  getSocketInstance();
  peers[0].handlers.get('auth.revoked')!();
  for (const peer of peers) {
    expect(peer.removeAllListeners).toHaveBeenCalledOnce();
    expect(peer.disconnect).toHaveBeenCalledOnce();
  }
  expect(replace).toHaveBeenCalledExactlyOnceWith('/projects');
});
