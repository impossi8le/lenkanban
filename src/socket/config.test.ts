import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getAppOrigin,
  getInternalEmitUrl,
  getSessionApiUrl,
  getSocketPort,
  parsePort,
} from "./config";

const ORIGIN_VARS = ["NEXT_PUBLIC_APP_URL", "APP_URL", "NEXTAUTH_URL"] as const;
const clearOrigins = () => ORIGIN_VARS.forEach(name => vi.stubEnv(name, undefined));

afterEach(() => { vi.unstubAllEnvs(); });

describe("socket endpoint configuration", () => {
  it.each([
    [undefined, 3556], ["", 3556], ["   ", 3556], ["0", 3556], ["65536", 3556],
    ["-1", 3556], ["1.5", 3556], ["not-a-port", 3556], ["3556", 3556],
    ["4000", 4000], ["65535", 65535],
  ])("parses %j into a bounded port", (raw, expected) => {
    expect(parsePort(raw, 3556)).toBe(expected);
  });

  it("uses one loopback bridge endpoint and ignores hostile ports", () => {
    vi.stubEnv("INTERNAL_EMIT_HOST", undefined);
    vi.stubEnv("SOCKET_PORT", "4001");
    expect(getInternalEmitUrl()).toBe("http://127.0.0.1:4001/internal/emit");
    vi.stubEnv("SOCKET_PORT", "attacker.invalid:9999/path");
    expect(getSocketPort()).toBe(3556);
    expect(getInternalEmitUrl()).toBe("http://127.0.0.1:3556/internal/emit");
  });

  it.each(["socket", "taskboard-socket", "socket.internal", "172.18.0.2", "10.0.0.1"])("supports explicit internal bridge host %s", host => {
    vi.stubEnv("INTERNAL_EMIT_HOST", host);
    vi.stubEnv("SOCKET_PORT", "3556");
    expect(getInternalEmitUrl()).toBe(`http://${host}:3556/internal/emit`);
  });

  it("brackets a valid IPv6 host", () => {
    vi.stubEnv("INTERNAL_EMIT_HOST", "::1");
    vi.stubEnv("SOCKET_PORT", "3556");
    expect(getInternalEmitUrl()).toBe("http://[::1]:3556/internal/emit");
  });

  it.each(["http://socket", "socket:3556", "user@socket", "socket/path", "socket?x=1", "socket#hash", "socket\\evil", "socket\nevil", "999.1.1.1", "127.1", "-socket", "socket_1", "", " "])("rejects malformed bridge host %j", host => {
    vi.stubEnv("INTERNAL_EMIT_HOST", host);
    vi.stubEnv("SOCKET_PORT", "3556");
    expect(getInternalEmitUrl()).toBe("http://127.0.0.1:3556/internal/emit");
  });

  it("has no historical domain fallback", () => {
    clearOrigins();
    expect(getAppOrigin()).toBeUndefined();
  });

  it.each([
    ["NEXT_PUBLIC_APP_URL", "https://public.example.invalid"],
    ["APP_URL", "http://app.example.invalid:3555"],
    ["NEXTAUTH_URL", "https://auth.example.invalid"],
  ] as const)("uses %s when it is the first valid configured origin", (name, value) => {
    clearOrigins();
    vi.stubEnv(name, ` ${value}/ignored/path `);
    expect(getAppOrigin()).toBe(value);
  });

  it("prefers public app URL over server URL and auth URL", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://public.example.invalid");
    vi.stubEnv("APP_URL", "https://app.example.invalid");
    vi.stubEnv("NEXTAUTH_URL", "https://auth.example.invalid");
    expect(getAppOrigin()).toBe("https://public.example.invalid");
  });

  it.each([
    "ftp://files.example.invalid",
    "https://user:secret@private.example.invalid",
    "https://app.example.invalid/?token=synthetic",
    "https://app.example.invalid/#fragment",
    "not a url",
  ])("rejects an invalid configured origin %j", value => {
    clearOrigins();
    vi.stubEnv("NEXT_PUBLIC_APP_URL", value);
    expect(getAppOrigin()).toBeUndefined();
  });

  it("derives the session endpoint from the configured origin without query data", () => {
    clearOrigins();
    vi.stubEnv("NEXTAUTH_URL", "https://auth.example.invalid/base");
    expect(getSessionApiUrl().toString()).toBe("https://auth.example.invalid/api/auth/session");
  });

  it("falls back to the configured local app port, never a deployed domain", () => {
    clearOrigins();
    vi.stubEnv("PORT", "4444");
    expect(getSessionApiUrl().toString()).toBe("http://127.0.0.1:4444/api/auth/session");
    vi.stubEnv("PORT", "invalid");
    expect(getSessionApiUrl().toString()).toBe("http://127.0.0.1:3555/api/auth/session");
  });
});
