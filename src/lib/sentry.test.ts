import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  setExtras: vi.fn(),
  captureException: vi.fn(),
  setContext: vi.fn(),
  setUser: vi.fn(),
  addBreadcrumb: vi.fn(),
  captureMessage: vi.fn(),
  withScope: vi.fn()
}));
vi.mock("@sentry/nextjs", () => ({
  ...mocks,
  withScope: (callback: (scope: {
    setExtras: typeof mocks.setExtras;
    setUser: typeof mocks.setUser;
  }) => void) => {
    mocks.withScope();
    callback({
      setExtras: mocks.setExtras,
      setUser: mocks.setUser
    });
  }
}));
import { captureException, setUser, addBreadcrumb, captureMessage, withSentry } from "./sentry";
it("uses operation scope, safe extras and never sets shared additional context", () => {
  const err = Error("private");
  const requestId = "30dc9a4d-3fdc-4f04-b5db-604b4d4c6b93";
  captureException(err, {
    requestId,
    password: "private"
  });
  expect(mocks.withScope).toHaveBeenCalledOnce();
  expect(mocks.setExtras).toHaveBeenCalledWith({
    requestId
  });
  expect(mocks.setContext).not.toHaveBeenCalled();
  expect(mocks.captureException).toHaveBeenCalledWith(err);
  expect(mocks.setUser).toHaveBeenCalledWith(null);
});
it("preserves original operation error and success when the SDK throws", async () => {
  mocks.withScope.mockImplementation(() => {
    throw Error("SDK offline");
  });
  const original = Error("business error");
  await expect(withSentry(async () => {
    throw original;
  })()).rejects.toBe(original);
  expect(() => captureException(original)).not.toThrow();
  mocks.captureMessage.mockImplementation(() => {
    throw Error("SDK offline");
  });
  mocks.setUser.mockImplementation(() => {
    throw Error("SDK offline");
  });
  mocks.addBreadcrumb.mockImplementation(() => {
    throw Error("SDK offline");
  });
  expect(() => captureMessage("private")).not.toThrow();
  expect(() => setUser(null)).not.toThrow();
  expect(() => addBreadcrumb({
    message: "private"
  })).not.toThrow();
  await expect(withSentry(async () => "ok")()).resolves.toBe("ok");
});
it("keeps safe legacy identity/breadcrumb helpers without email, input or messages", () => {
  setUser({
    id: "actor-1",
    email: "private@example.invalid",
    username: "private"
  });
  addBreadcrumb({
    message: "private",
    data: {
      password: "private"
    }
  });
  captureMessage("private");
  expect(mocks.setUser).toHaveBeenCalledWith({
    id: "actor-1"
  });
  expect(mocks.addBreadcrumb).toHaveBeenCalledWith({
    category: "application",
    data: {}
  });
  expect(mocks.captureMessage).toHaveBeenCalledWith("Application event", "info");
});
