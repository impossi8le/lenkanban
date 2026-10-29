import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  prisma: {
    user: { findUnique: vi.fn() },
    project: { findUnique: vi.fn() },
    task: { findUnique: vi.fn() },
  },
  io: { use: vi.fn(), on: vi.fn(), to: vi.fn() },
  accountAllowed: vi.fn(),
}));

vi.mock("@prisma/client", async importOriginal => ({
  ...await importOriginal<typeof import("@prisma/client")>(),
  PrismaClient: class { constructor() { return dependencies.prisma; } },
}));
vi.mock("socket.io", () => ({
  Server: class { constructor() { return dependencies.io; } },
}));
vi.mock("@/lib/notification-triggers", () => ({ notifyChatMessage: vi.fn() }));
vi.mock("./visibility-delivery", () => ({ createVisibilityDelivery: () => ({
  task: vi.fn(), revalidate: vi.fn(), dispatch: vi.fn(),
}) }));
vi.mock("@/lib/logger", () => ({
  socketLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/auth", () => ({ isAccountAllowed: dependencies.accountAllowed }));

type Middleware = (socket: unknown, next: (error?: Error) => void) => Promise<void>;
let middleware: Middleware;

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  await import("./server");
  middleware = dependencies.io.use.mock.calls.at(-1)?.[0];
  expect(typeof middleware).toBe("function");
});

function socket(cookie: string) {
  return {
    id: "socket-blocked",
    request: { headers: { cookie } },
    data: {} as Record<string, unknown>,
    on: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
  };
}

describe("socket account status gate (#14)", () => {
  it("rejects a connection without a session cookie before any account lookup", async () => {
    const next = vi.fn();
    await middleware(socket(""), next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(dependencies.accountAllowed).not.toHaveBeenCalled();
  });
});
