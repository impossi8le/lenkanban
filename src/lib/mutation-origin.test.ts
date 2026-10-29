import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError } from "./errors";
import { requireTrustedMutationOrigin, trustedMutationOrigin } from "./mutation-origin";

const variables = ["NEXT_PUBLIC_APP_URL", "APP_URL", "NEXTAUTH_URL"] as const;
const input = (origin: string | null = "https://public.test", headers: Record<string, string> = {}) =>
  new Request("http://localhost:3000/api/tasks/task", {
    method: "POST", headers: { ...(origin === null ? {} : { origin }), ...headers },
  });

beforeEach(() => variables.forEach(name => vi.stubEnv(name, undefined)));
afterEach(() => vi.unstubAllEnvs());

describe("trusted mutation Origin", () => {
  it.each(variables)("accepts explicit %s behind an internal proxy URL", name => {
    vi.stubEnv(name, "https://public.test/base");
    expect(trustedMutationOrigin(input())).toBe("https://public.test");
    expect(() => requireTrustedMutationOrigin(input())).not.toThrow();
  });

  it("preserves application origin precedence", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://public.test");
    vi.stubEnv("APP_URL", "https://server.test");
    vi.stubEnv("NEXTAUTH_URL", "https://auth.test");
    expect(() => requireTrustedMutationOrigin(input())).not.toThrow();
    expect(() => requireTrustedMutationOrigin(input("https://auth.test"))).toThrow(ForbiddenError);
  });

  it.each(["https://evil.test", "http://localhost:3000", "null", "https://public.test/"])("rejects non-matching browser Origin %s", origin => {
    vi.stubEnv("NEXTAUTH_URL", "https://public.test");
    expect(() => requireTrustedMutationOrigin(input(origin, {
      host: "evil.test", "x-forwarded-host": "evil.test", "x-forwarded-proto": "https",
    }))).toThrow(ForbiddenError);
  });

  it("ignores attacker supplied proxy headers when no public URL is configured", () => {
    expect(() => requireTrustedMutationOrigin(input("https://evil.test", {
      host: "evil.test", "x-forwarded-host": "evil.test", forwarded: "host=evil.test;proto=https",
    }))).toThrow(ForbiddenError);
    expect(() => requireTrustedMutationOrigin(input("http://localhost:3000"))).not.toThrow();
  });

  it.each(["not a url", "ftp://public.test", "https://user:pass@public.test", "https://public.test/?secret=synthetic", "https://public.test/#fragment"])("fails closed for malformed explicit configuration %s", value => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", value);
    vi.stubEnv("NEXTAUTH_URL", "http://localhost:3000");
    expect(() => requireTrustedMutationOrigin(input("http://localhost:3000"))).toThrow(ForbiddenError);
  });

  it("requires Origin for cookie mutations and rejects cross-site before bearer waiver", () => {
    vi.stubEnv("NEXTAUTH_URL", "https://public.test");
    expect(() => requireTrustedMutationOrigin(input(null))).toThrow(ForbiddenError);
    expect(() => requireTrustedMutationOrigin(input(null, { authorization: "Bearer verified", "sec-fetch-site": "cross-site" }))).toThrow(ForbiddenError);
    expect(() => requireTrustedMutationOrigin(input(null, { authorization: "Bearer verified" }))).not.toThrow();
    expect(() => requireTrustedMutationOrigin(input(null, { authorization: "Bearer\tunsupported" }))).toThrow(ForbiddenError);
  });
});
