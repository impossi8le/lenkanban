import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Notification } from "@prisma/client";
import { Server } from "socket.io";
import { io, type Socket } from "socket.io-client";
import { afterEach, expect, it, vi } from "vitest";
import { emitUserNotification } from "./board-events";
import { createInternalEmitRequestHandler } from "./internal-emit-handler";
import { createRoomSubscriptions } from "./room-subscriptions";

const serviceSecret = "synthetic-notification-transport-service-secret";
const waitMs = 2000;

function socketEvent(socket: Socket, event: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const listener = (...args: unknown[]) => { clearTimeout(timer); resolve(args); };
    const timer = setTimeout(() => {
      socket.off(event, listener);
      reject(new Error(`Timed out waiting for synthetic transport event ${event}`));
    }, waitMs);
    socket.once(event, listener);
  });
}

afterEach(() => { vi.unstubAllEnvs(); });

it("routes exact personal rows over real loopback HTTP and Socket.IO transport with synthetic auth, including reconnect/rejoin", async () => {
  // This fixture authenticates synthetic session names; it does not exercise
  // application auth, the production server, a database, or private visibility.
  const sessions = new Map([["synthetic-session-a", "actor-a"], ["synthetic-session-b", "actor-b"]]);
  let bridgeFinished: ((status: number) => void) | undefined;
  const httpServer = createServer((request, response) => {
    if (request.url === "/internal/emit") {
      response.once("finish", () => { bridgeFinished?.(response.statusCode); });
      bridgeHandler(request, response);
      return;
    }
    response.writeHead(404).end();
  });
  const server = new Server(httpServer, { transports: ["websocket"], serveClient: false });
  const bridgeHandler = createInternalEmitRequestHandler(server, { secret: serviceSecret });
  server.use((socket, next) => {
    const userId = sessions.get(socket.handshake.auth.syntheticSession);
    if (!userId) return next(new Error("Synthetic session required"));
    socket.data.userId = userId;
    next();
  });
  server.on("connection", socket => {
    const rooms = createRoomSubscriptions({
      expectedUserId: socket.data.userId,
      authenticate: async () => {
        const userId = sessions.get(socket.handshake.auth.syntheticSession);
        return userId ? { userId, globalRole: "USER" } : null;
      },
      canReadProject: async () => false,
      taskProject: async () => null,
      join: room => socket.join(room),
      leave: room => socket.leave(room),
    });
    socket.on("notification:join", ack => { void rooms.joinNotifications(ack); });
    socket.on("notification:leave", () => { void rooms.leaveNotifications(); });
    socket.on("disconnect", () => rooms.disconnect());
  });
  const clients: Socket[] = [];
  const receivedA: unknown[] = [];
  const receivedB: unknown[] = [];

  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", () => { httpServer.off("error", reject); resolve(); });
    });
    const port = (httpServer.address() as AddressInfo).port;
    vi.stubEnv("SOCKET_PORT", String(port));
    vi.stubEnv("INTERNAL_EMIT_SECRET", serviceSecret);
    const clientA = io(`http://127.0.0.1:${port}`, {
      auth: { syntheticSession: "synthetic-session-a" }, transports: ["websocket"],
      autoConnect: false, reconnection: false, forceNew: true,
    });
    const clientB = io(`http://127.0.0.1:${port}`, {
      auth: { syntheticSession: "synthetic-session-b" }, transports: ["websocket"],
      autoConnect: false, reconnection: false, forceNew: true,
    });
    clients.push(clientA, clientB);
    clientA.on("notification:new", row => receivedA.push(row));
    clientB.on("notification:new", row => receivedB.push(row));
    const firstConnections = [socketEvent(clientA, "connect"), socketEvent(clientB, "connect")];
    clientA.connect(); clientB.connect();
    await Promise.all(firstConnections);
    expect(await clientA.timeout(waitMs).emitWithAck("notification:join")).toEqual({ ok: true });
    expect(await clientB.timeout(waitMs).emitWithAck("notification:join")).toEqual({ ok: true });

    const barrier = async () => {
      const observed = [socketEvent(clientA, "synthetic:delivery-barrier"), socketEvent(clientB, "synthetic:delivery-barrier")];
      server.emit("synthetic:delivery-barrier");
      await Promise.all(observed);
    };
    const deliver = async (row: Notification) => {
      let timer: ReturnType<typeof setTimeout>;
      const completed = new Promise<number>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Synthetic loopback bridge response timed out")), waitMs);
        bridgeFinished = resolve;
      });
      try {
        emitUserNotification(row);
        expect(await completed).toBe(200);
      } finally {
        clearTimeout(timer!);
        bridgeFinished = undefined;
      }
      // Each client's ordered barrier follows the bridge emit, allowing an
      // absence assertion without a sleep or polling interval.
      await barrier();
    };
    const rowA: Notification = {
      id: "notice-a", userId: "actor-a", type: "task_assigned", title: "Synthetic title A",
      message: "Synthetic private row A", actionUrl: "/my-tasks", metadata: { taskId: "task-a" },
      read: false, readAt: null, createdAt: new Date("2026-10-21T10:00:00Z"),
    };
    const rowB: Notification = { ...rowA, id: "notice-b", userId: "actor-b", message: "Synthetic private row B" };
    const serialized = (row: Notification) => JSON.parse(JSON.stringify(row));

    await deliver(rowA);
    expect(receivedA).toEqual([serialized(rowA)]);
    expect(receivedB).toEqual([]);
    await deliver(rowB);
    expect(receivedA).toEqual([serialized(rowA)]);
    expect(receivedB).toEqual([serialized(rowB)]);

    const originalSocketId = clientA.id;
    clientA.disconnect();
    const reconnected = socketEvent(clientA, "connect");
    clientA.connect();
    await reconnected;
    expect(clientA.id).not.toBe(originalSocketId);
    expect(await clientA.timeout(waitMs).emitWithAck("notification:join")).toEqual({ ok: true });
    const laterA: Notification = { ...rowA, id: "notice-a-later", message: "Synthetic later row A" };
    await deliver(laterA);
    expect(receivedA).toEqual([serialized(rowA), serialized(laterA)]);
    expect(receivedB).toEqual([serialized(rowB)]);

    sessions.delete("synthetic-session-a");
    expect(await clientA.timeout(waitMs).emitWithAck("notification:join")).toMatchObject({ ok: false, error: "Unauthorized" });
    await deliver({ ...rowA, id: "notice-after-denied-rejoin" });
    expect(receivedA).toEqual([serialized(rowA), serialized(laterA)]);
    expect(receivedB).toEqual([serialized(rowB)]);
  } finally {
    for (const client of clients) client.disconnect();
    server.disconnectSockets(true);
    httpServer.closeAllConnections();
    await new Promise<void>(resolve => { server.close(() => resolve()); });
    if (httpServer.listening) await new Promise<void>((resolve, reject) => {
      httpServer.close(error => error ? reject(error) : resolve());
    });
  }
}, 15000);
