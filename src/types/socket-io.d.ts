import type { Server as HttpServer } from "http";
import type { Socket as NetSocket } from "net";
import type { Server as IOServer } from "socket.io";

declare global {
  var io: IOServer | undefined;

  // for Next.js dev hot-reload typing
  interface SocketServerWithIO extends HttpServer {
    io?: IOServer;
  }

  interface NextApiResponseWithSocket {
    socket: NetSocket & {
      server: SocketServerWithIO;
    };
  }
}

export {};
