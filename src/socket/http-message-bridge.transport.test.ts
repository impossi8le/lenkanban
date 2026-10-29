import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { io, type Socket } from 'socket.io-client';
import { expect, it } from 'vitest';
import { createInternalEmitRequestHandler } from './internal-emit-handler';
import { createVisibilityDelivery } from './visibility-delivery';

it.each(['message:new', 'message:updated'])('delivers signed HTTP %s to live readers while enforcing private discussion and current file permission', async event => {
  const http = createServer();
  const server = new Server(http, { transports: ['websocket'], serveClient: false });
  const secret = 'synthetic-http-message-bridge-secret';
  let fileReadable = true;
  const delivery = createVisibilityDelivery({
    sockets: () => server.sockets.sockets.values(),
    canReadTask: async actor => actor !== 'outsider',
    canReadProject: async () => true,
    canReadNotification: async () => false,
    canReadMessage: async (actor, _taskId, data) => {
      const message = data as { isInternal: boolean };
      return fileReadable && (!message.isInternal || actor === 'author');
    },
  });
  const bridge = createInternalEmitRequestHandler(server, { secret, dispatch: delivery.dispatch });
  http.on('request', (request, response) => { bridge(request, response); });
  server.on('connection', async socket => {
    socket.data.userId = socket.handshake.auth.actor;
    await socket.join('project:p');
    socket.on('barrier', (ack: () => void) => ack());
  });
  const clients: Socket[] = [];
  const observed = new Map<string, unknown[]>();
  try {
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    for (const actor of ['author','executor','outsider']) {
      const client = io(origin, { auth:{actor}, transports:['websocket'], reconnection:false, forceNew:true, autoConnect:false });
      clients.push(client); observed.set(actor, []);
      client.on(event, message => observed.get(actor)!.push(message));
      await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); client.connect(); });
      await client.timeout(2000).emitWithAck('barrier');
    }
    const message = { id:'m',taskId:'t',authorId:'author',author:{id:'author'},contentText:'Synthetic answer',attachments:[],visibility:'PUBLIC',isInternal:false };
    const send = (data: object, bearer=secret) => fetch(`${origin}/internal/emit`, {method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${bearer}`},body:JSON.stringify({event,roomId:'project:p',data})});
    const flush = () => Promise.all(clients.filter(client => client.connected).map(client => new Promise<void>(resolve => { client.once('delivery:barrier', resolve); server.to(client.id!).emit('delivery:barrier'); })));
    expect((await send(message, 'wrong-synthetic-secret')).status).toBe(401);
    expect((await send(message)).status).toBe(200); await flush();
    expect(observed.get('author')).toEqual([message]); expect(observed.get('executor')).toEqual([message]);
    expect(observed.get('outsider')).toEqual([]);
    const internal = {...message,id:'internal',visibility:'INTERNAL',isInternal:true};
    expect((await send(internal)).status).toBe(200); await flush();
    expect(observed.get('author')).toEqual([message,internal]); expect(observed.get('executor')).toEqual([message]);
    fileReadable = false;
    expect((await send({...message,id:'revoked-file'})).status).toBe(200); await flush();
    expect(observed.get('author')).toHaveLength(2); expect(observed.get('executor')).toHaveLength(1);
  } finally {
    for (const client of clients) client.disconnect();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 15000);
