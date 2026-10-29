import { io, type Socket } from "socket.io-client";

let globalSocket: Socket | null = null;
const connections = new Set<Socket>();
let resetting = false;

function resetProtectedState() {
  if (resetting || typeof window === "undefined") return;
  resetting = true;
  // A document navigation destroys React state, query/mutation caches and
  // pending fetch consumers, including tasks loaded before this socket existed.
  for (const socket of connections) {
    socket.removeAllListeners();
    socket.disconnect();
  }
  connections.clear();
  globalSocket = null;
  window.location.replace("/projects");
}

/** Separate channels share transport configuration, never event payload logging. */
export function createSocketConnection(): Socket {
  const url = process.env.NEXT_PUBLIC_SOCKET_URL?.trim() || undefined;
  const socket = io(url, {
    path: "/socket.io",
    // Establish realtime over HTTP first; a slow/blocked WebSocket upgrade must
    // not hold notification joins hostage. Socket.IO upgrades in the background.
    transports: ["polling", "websocket"],
    withCredentials: true,
    autoConnect: true,
  });
  connections.add(socket);
  socket.on("connect", () => connections.add(socket));
  socket.on("disconnect", () => connections.delete(socket));
  socket.on("auth.revoked", resetProtectedState);
  socket.on("project:access-revoked", resetProtectedState);
  return socket;
}

export function getSocketInstance(): Socket {
  if (!globalSocket) globalSocket = createSocketConnection();
  return globalSocket;
}

export function disconnectSocket() {
  if (globalSocket) {
    globalSocket.disconnect();
    globalSocket = null;
  }
}
