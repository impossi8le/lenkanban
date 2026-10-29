import { describe, expect, it, vi, type Mock } from 'vitest';
import { createVisibilityDelivery, type VisibilitySocket } from './visibility-delivery';

type SocketMock = VisibilitySocket & { disconnect: Mock<(close?: boolean) => unknown> };

function socket(id: string, userId: string, rooms: string[]) {
  const value: SocketMock = {
    id,
    data: { userId },
    rooms: new Set([id, ...rooms]),
    emit: vi.fn(),
    leave: vi.fn(function (this: VisibilitySocket, room: string) { this.rooms.delete(room); }),
    disconnect: vi.fn<(close?: boolean) => unknown>(),
  };
  return value;
}

function dependencies(sockets: VisibilitySocket[], blocked: string | null = null) {
  return {
    sockets: () => sockets,
    canReadTask: vi.fn(async () => true),
    canReadProject: vi.fn(async () => true),
    canReadNotification: vi.fn(async () => true),
    isAccountAllowed: vi.fn(async (userId: string) => userId !== blocked),
  };
}

describe('continuous account revocation (#40)', () => {
  it('resets all actor sockets on role change even with no known tasks', async () => {
    const first = socket('s1', 'a', ['user:a']);
    const second = socket('s2', 'a', ['user:a']);
    first.data.globalRole = 'ADMIN';
    second.data.globalRole = 'ADMIN';
    const delivery = createVisibilityDelivery({
      ...dependencies([first, second]), currentGlobalRole: async () => 'USER',
    });
    expect(await delivery.revalidate(first)).toBe(false);
    for (const target of [first, second]) {
      expect(target.emit).toHaveBeenCalledWith('auth.revoked', { userId: 'a', reason: 'role-changed' });
      expect(target.disconnect).toHaveBeenCalledWith(true);
    }
  });
  it('sweeps a blocked account out of every room, including user:*, then disconnects it', async () => {
    const blocked = socket('s1', 'a', ['project:p', 'task:t', 'user:a']);
    const peer = socket('s2', 'b', ['project:p', 'user:b']);
    const deps = dependencies([blocked, peer], 'a');
    const delivery = createVisibilityDelivery(deps);

    await delivery.revalidate(blocked);

    expect(blocked.leave).toHaveBeenCalledWith('project:p');
    expect(blocked.leave).toHaveBeenCalledWith('task:t');
    expect(blocked.leave).toHaveBeenCalledWith('user:a');
    expect(blocked.rooms).toEqual(new Set(['s1']));
    expect(blocked.emit).toHaveBeenCalledExactlyOnceWith('auth.revoked', { userId: 'a', reason: 'account-blocked' });
    expect(blocked.disconnect).toHaveBeenCalledExactlyOnceWith(true);
    // The cheap status gate short-circuits before per-room policy queries.
    expect(deps.canReadProject).not.toHaveBeenCalled();
    expect(deps.canReadTask).not.toHaveBeenCalled();
    expect(peer.disconnect).not.toHaveBeenCalled();
    expect(peer.emit).not.toHaveBeenCalled();
  });

  it('routes an auth.revoked fanout to every socket of that actor only', async () => {
    const first = socket('s1', 'a', ['user:a']);
    const second = socket('s2', 'a', ['user:a']);
    const peer = socket('s3', 'b', ['user:b']);
    const deps = dependencies([first, second, peer]);
    const delivery = createVisibilityDelivery(deps);

    await delivery.dispatch('auth.revoked', 'user:a', { userId: 'a', reason: 'role-demoted' });

    for (const target of [first, second]) {
      expect(target.leave).toHaveBeenCalledWith('user:a');
      expect(target.emit).toHaveBeenCalledExactlyOnceWith('auth.revoked', { userId: 'a', reason: 'role-demoted' });
      expect(target.disconnect).toHaveBeenCalledExactlyOnceWith(true);
    }
    expect(peer.leave).not.toHaveBeenCalled();
    expect(peer.emit).not.toHaveBeenCalled();
    expect(peer.disconnect).not.toHaveBeenCalled();
  });

  it('checks project access once per socket per dispatch', async () => {
    const a = socket('s1', 'a', ['project:p']);
    const b = socket('s2', 'b', ['project:p']);
    const deps = dependencies([a, b]);
    const delivery = createVisibilityDelivery(deps);

    await delivery.dispatch('column:updated', 'project:p', { id: 'c1', projectId: 'p' });

    expect(deps.canReadProject).toHaveBeenCalledTimes(2);
    expect(a.emit).toHaveBeenCalledExactlyOnceWith('column:updated', { id: 'c1', projectId: 'p' });
    expect(b.emit).toHaveBeenCalledExactlyOnceWith('column:updated', { id: 'c1', projectId: 'p' });
  });

  it('reuses one account status read for peers in the same sweep window', async () => {
    const first = socket('s1', 'a', ['user:a']);
    const second = socket('s2', 'a', ['user:a']);
    const deps = dependencies([first, second]);
    const delivery = createVisibilityDelivery(deps);

    await delivery.revalidate(first);
    await delivery.revalidate(second);

    expect(deps.isAccountAllowed).toHaveBeenCalledTimes(1);
  });
});
