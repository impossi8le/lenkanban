import { describe, expect, it, vi } from "vitest";

import {
  memoizeInRequest,
  recallResolvedIdentity,
  rememberResolvedIdentity,
} from "./session-cache";

function httpRequest(url = "http://localhost/api/tasks") {
  return new Request(url);
}

describe("memoizeInRequest", () => {
  it("runs the loader once for every guard of the same request", async () => {
    const load = vi.fn(async () => ({ id: "user-1" }));
    const request = httpRequest();

    const [first, second] = await Promise.all([
      memoizeInRequest(request, "user:user-1", load),
      memoizeInRequest(request, "user:user-1", load),
    ]);
    await memoizeInRequest(request, "user:user-1", load);

    expect(first).toEqual({ id: "user-1" });
    expect(second).toEqual({ id: "user-1" });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not share entries between two requests", async () => {
    const load = vi.fn(async () => ({ id: "user-1" }));

    await memoizeInRequest(httpRequest(), "user:user-1", load);
    await memoizeInRequest(httpRequest(), "user:user-1", load);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps different keys independent", async () => {
    const load = vi.fn(async (id: string) => ({ id }));
    const request = httpRequest();

    expect(await memoizeInRequest(request, "user:a", () => load("a"))).toEqual({ id: "a" });
    expect(await memoizeInRequest(request, "user:b", () => load("b"))).toEqual({ id: "b" });

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("retries a failed read instead of replaying the failure", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce({ id: "user-1" });
    const request = httpRequest();

    await expect(memoizeInRequest(request, "user:user-1", load)).rejects.toThrow("connection reset");
    await expect(memoizeInRequest(request, "user:user-1", load)).resolves.toEqual({ id: "user-1" });

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not memoize without a request to scope it to", async () => {
    const load = vi.fn(async () => ({ id: "user-1" }));

    await memoizeInRequest(undefined, "user:user-1", load);
    await memoizeInRequest(null, "user:user-1", load);

    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("resolved identity", () => {
  it("is visible only to the session object that read it", () => {
    const reader = {};
    const other = {};

    rememberResolvedIdentity(reader, { user: null, status: "blocked" });

    expect(recallResolvedIdentity(reader)).toEqual({ user: null, status: "blocked" });
    expect(recallResolvedIdentity(other)).toBeNull();
    expect(recallResolvedIdentity(null)).toBeNull();
    expect(recallResolvedIdentity(undefined)).toBeNull();
  });
});
