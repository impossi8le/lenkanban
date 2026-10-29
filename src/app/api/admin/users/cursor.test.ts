import { describe, expect, it } from "vitest";

import {
  decodeUsersCursor,
  encodeUsersCursor,
  usersKeysetFilter,
} from "./cursor";

const createdAt = new Date("2026-10-20T10:00:00.000Z");

function opaque(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

describe("ADMIN users keyset cursor", () => {
  it("round-trips createdAt and id without exposing a raw identifier", () => {
    const encoded = encodeUsersCursor({ createdAt, id: "user-2" });
    expect(encoded).not.toBe("user-2");
    expect(encoded).not.toContain("user-2");
    expect(decodeUsersCursor(encoded)).toEqual({ createdAt, id: "user-2" });
  });

  it.each([
    ["empty", ""],
    ["plain text", "not-a-cursor"],
    ["empty object", opaque({})],
    ["missing id", opaque({ createdAt: createdAt.toISOString() })],
    ["missing createdAt", opaque({ id: "user-2" })],
    ["invalid date", opaque({ createdAt: "not-a-date", id: "user-2" })],
    ["array payload", opaque([createdAt.toISOString(), "user-2"])],
    ["oversized id", opaque({ createdAt: createdAt.toISOString(), id: "x".repeat(129) })],
  ])("rejects a malformed cursor (%s)", (_label, value) => {
    expect(decodeUsersCursor(value)).toBeNull();
  });

  it("builds a deterministic (createdAt desc, id desc) keyset filter", () => {
    expect(usersKeysetFilter({ createdAt, id: "user-2" })).toEqual({
      OR: [
        { createdAt: { lt: createdAt } },
        { createdAt, id: { lt: "user-2" } },
      ],
    });
  });
});
