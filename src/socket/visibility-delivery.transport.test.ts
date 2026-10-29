import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { io, type Socket } from 'socket.io-client';
import { expect, it } from 'vitest';
import { createVisibilityDelivery } from './visibility-delivery';

function event(socket: Socket, name: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(name, receive); reject(new Error('Synthetic transport timeout')); }, 2000);
    const receive = (data: unknown) => { clearTimeout(timer); resolve(data); };
    socket.once(name, receive);
  });
}

it('never delivers another subject\'s notification and stops after an unassignment without reconnect', async () => {
  const http = createServer();
  const server = new Server(http, { transports: ['websocket'], serveClient: false });
  const permitted = new Set(['a', 'b']);
  server.on('connection', async socket => {
    socket.data.userId = socket.handshake.auth.actor;
    await socket.join('project:p');
    await socket.join(`user:${socket.data.userId}`);
    socket.on('barrier', (ack: () => void) => ack());
  });
  const delivery = createVisibilityDelivery({
    sockets: () => server.sockets.sockets.values(),
    canReadTask: async actor => permitted.has(actor),
    canReadProject: async () => true,
    canReadNotification: async data => (data as { userId?: string }).userId === 'b',
  });
  const clients: Socket[] = [];
  try {
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    for (const actor of ['a', 'b']) {
      const client = io(url, { auth: { actor }, transports: ['websocket'], reconnection: false, forceNew: true, autoConnect: false });
      clients.push(client);
      const ready = event(client, 'connect');
      client.connect();
      await ready;
      // The server joins rooms asynchronously; wait until they are in place.
      await client.timeout(2000).emitWithAck('barrier');
    }
    const [a, b] = clients;
    const seenA: unknown[] = [], seenB: unknown[] = [];
    a.on('notification:new', row => seenA.push(row));
    b.on('notification:new', row => seenB.push(row));
    a.on('task:updated', row => seenA.push(row));
    b.on('task:updated', row => seenB.push(row));
    // A server-side emit is asynchronous on the wire; flush before asserting.
    const flush = async () => {
      const received = clients.filter(client => client.connected).map(client => event(client, 'delivery:barrier'));
      server.emit('delivery:barrier');
      await Promise.all(received);
    };

    // B's notification is bound to B's personal room, not to the project room.
    await delivery.dispatch('notification:new', 'user:b', { userId: 'b', title: 'private task' });
    await flush();
    expect(seenB).toEqual([{ userId: 'b', title: 'private task' }]);
    expect(seenA).toEqual([]);

    // Both are assigned here, so B's connection knows the task before the change.
    await delivery.dispatch('task:updated', 'project:p', { id: 't', title: 'before unassignment' });
    await flush();
    expect(seenA).toEqual([{ id: 't', title: 'before unassignment' }]);
    expect(seenB).toEqual([{ userId: 'b', title: 'private task' }, { id: 't', title: 'before unassignment' }]);

    // B is unassigned; the already open connection loses the task without reconnecting.
    permitted.delete('b');
    const evicted = event(b, 'auth.revoked');
    const disconnected = event(b, 'disconnect');
    await delivery.revalidate(server.sockets.sockets.get(b.id!)!);
    expect(await evicted).toEqual({ userId: 'b', reason: 'task-access-revoked' });
    await disconnected;
    await delivery.dispatch('task:updated', 'project:p', { id: 't', title: 'after unassignment' });
    await flush();
    expect(seenB).toEqual([
      { userId: 'b', title: 'private task' },
      { id: 't', title: 'before unassignment' },
    ]);
    expect(seenA).toEqual([
      { id: 't', title: 'before unassignment' },
      { id: 't', title: 'after unassignment' },
    ]);
    expect(b.connected).toBe(false);
  } finally {
    for (const client of clients) client.disconnect();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 15000);

it('isolates two connected clients and revokes one without reconnecting (synthetic policy, no DB/auth)', async () => {
  const http = createServer();
  const server = new Server(http, { transports: ['websocket'], serveClient: false });
  const permitted = new Set(['a']);
  server.on('connection', socket => {
    // Fixture-only identity and subscription. Production uses session validation.
    socket.data.userId = socket.handshake.auth.actor;
    void socket.join('project:p');
    socket.on('barrier', ack => ack());
  });
  const delivery = createVisibilityDelivery({
    sockets: () => server.sockets.sockets.values(),
    canReadTask: async actor => permitted.has(actor),
    canReadProject: async () => true,
    canReadNotification: async () => false,
  });
  const clients: Socket[] = [];
  try {
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    for (const actor of ['a', 'b']) {
      const client = io(url, { auth: { actor }, transports: ['websocket'], reconnection: false, forceNew: true, autoConnect: false });
      clients.push(client);
      const ready = event(client, 'connect');
      client.connect();
      await ready;
      await client.timeout(2000).emitWithAck('barrier');
    }
    const [a, b] = clients;
    const observedA: unknown[] = [], observedB: unknown[] = [];
    a.on('task:updated', row => observedA.push(row));
    b.on('task:updated', row => observedB.push(row));
    const barrier = async () => {
      const received = clients.filter(client => client.connected).map(client => event(client, 'delivery:barrier'));
      server.emit('delivery:barrier');
      await Promise.all(received);
    };
    await delivery.dispatch('task:updated', 'project:p', { id: 't', title: 'private' });
    await barrier();
    expect(observedA).toEqual([{ id: 't', title: 'private' }]);
    expect(observedB).toEqual([]);
    permitted.delete('a');
    const removed = event(a, 'auth.revoked');
    const disconnected = event(a, 'disconnect');
    const connectedA = server.sockets.sockets.get(a.id!)!;
    await delivery.revalidate(connectedA);
    expect(await removed).toEqual({ userId: 'a', reason: 'task-access-revoked' });
    await disconnected;
    permitted.add('b');
    await delivery.dispatch('task:updated', 'project:p', { id: 't', title: 'after transfer' });
    await barrier();
    expect(a.connected).toBe(false);
    expect(observedA).toEqual([{ id: 't', title: 'private' }]);
    expect(observedB).toEqual([{ id: 't', title: 'after transfer' }]);
  } finally {
    for (const client of clients) client.disconnect();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 15000);
