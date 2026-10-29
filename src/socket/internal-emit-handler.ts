import { isIP } from "node:net";
import { hasConfiguredServiceSecret, isServiceBearerAuthorized } from "../lib/service-auth";
import { isInternalEmitPayload } from "./internal-emit-contract";

export interface InternalEmitHandlerOptions {
  /** Production dispatch must authorize each current recipient, never trust rooms. */
  dispatch?: (event: string, roomId: string, data: unknown) => Promise<void>;
  secret?: string;
  maxBodyBytes?: number;
  /** Explicit container-network opt-in; authentication remains mandatory. */
  allowPrivateNetwork?: boolean;
  onError?: (err: unknown) => void;
}

export interface InternalEmitRequest {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
  on(event: "data", listener: (chunk: unknown) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (err: unknown) => void): unknown;
}

export interface InternalEmitResponse {
  writeHead(statusCode: number, headers?: Record<string, string>): unknown;
  end(chunk?: string): unknown;
}

export interface InternalEmitSocketServer {
  to(roomId: string): { emit(event: string, data: unknown): unknown };
}

const LOOPBACK_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

function isPrivatePeer(address: string): boolean {
  let ipv4 = address;
  if (isIP(address) === 6) {
    // URL canonicalization handles both dotted and expanded IPv4-mapped IPv6.
    const canonical = new URL(`http://[${address}]`).hostname;
    const mapped = /^\[::ffff:([\da-f]{1,4}):([\da-f]{1,4})\]$/i.exec(canonical);
    if (!mapped) return false;
    const high = Number.parseInt(mapped[1], 16);
    const low = Number.parseInt(mapped[2], 16);
    ipv4 = `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
  }
  if (isIP(ipv4) !== 4) return false;
  const [first, second] = ipv4.split(".").map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
}

export function createInternalEmitRequestHandler(
  io: InternalEmitSocketServer,
  options: InternalEmitHandlerOptions = {}
): (req: InternalEmitRequest, res: InternalEmitResponse) => void {
  const maxBytes = Number.isSafeInteger(options.maxBodyBytes) && (options.maxBodyBytes ?? 0) > 0
    ? Math.min(options.maxBodyBytes!, DEFAULT_MAX_BODY_BYTES)
    : DEFAULT_MAX_BODY_BYTES;

  const safeOnError = (err: unknown) => {
    try {
      options.onError?.(err);
    } catch { /* Diagnostic failure never changes bridge handling. */ }
  };

  return (req, res) => {
    let pathname = "";
    try {
      pathname = new URL(req.url ?? "", "http://localhost").pathname;
    } catch {
      return;
    }
    if (pathname !== "/internal/emit") return;

    let responded = false;
    const send = (status: number, msg?: string) => {
      if (responded) return;
      responded = true;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(msg ? JSON.stringify({ error: msg }) : undefined);
    };

    if (req.method !== "POST") return send(405, "Method Not Allowed");
    if (!hasConfiguredServiceSecret(options.secret)) return send(503, "Service Unavailable");

    const remoteIp = req.socket?.remoteAddress;
    if (!remoteIp || (!LOOPBACK_IPS.has(remoteIp) &&
      !(options.allowPrivateNetwork === true && isPrivatePeer(remoteIp)))) return send(403, "Forbidden");
    if (!isServiceBearerAuthorized(req.headers?.authorization, options.secret)) return send(401, "Unauthorized");

    let receivedBytes = 0;
    let oversized = false;
    const chunks: Buffer[] = [];

    req.on("data", (chunk: unknown) => {
      if (oversized || responded) return;
      if (!Buffer.isBuffer(chunk) && typeof chunk !== "string") {
        chunks.length = 0;
        return send(400, "Invalid body chunk");
      }
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      receivedBytes += buf.length;
      if (receivedBytes > maxBytes) {
        oversized = true;
        chunks.length = 0;
        return send(413, "Payload Too Large");
      }
      chunks.push(buf);
    });

    req.on("error", (err) => {
      safeOnError(err);
      send(500, "Internal Server Error");
    });

    req.on("end", async () => {
      if (oversized || responded) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return send(400, "Malformed JSON");
      }

      if (!isInternalEmitPayload(parsed)) return send(400, "Invalid Emit Contract");

      try {
        if (options.dispatch) await options.dispatch(parsed.event, parsed.roomId, parsed.data);
        else io.to(parsed.roomId).emit(parsed.event, parsed.data);
        responded = true;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        safeOnError(err);
        send(500, "Internal Server Error");
      }
    });
  };
}
