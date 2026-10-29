import { describe, expect, it } from "vitest";

import {
  decodeProjectsCursor,
  encodeProjectsCursor,
  projectsKeysetFilter,
} from "./cursor";

const createdAt = new Date("2026-10-20T10:00:00.000Z");

function opaque(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

describe("ADMIN projects keyset cursor", () => {
  it("round-trips createdAt and id without exposing a raw identifier", () => {
    const encoded = encodeProjectsCursor({ createdAt, id: "project-2" });
    expect(encoded).not.toBe("project-2");
    expect(encoded).not.toContain("project-2");
    expect(decodeProjectsCursor(encoded)).toEqual({ createdAt, id: "project-2" });
  });

  it.each([
    ["empty", ""],
    ["plain text", "not-a-cursor"],
    ["empty object", opaque({})],
    ["missing id", opaque({ createdAt: createdAt.toISOString() })],
    ["missing createdAt", opaque({ id: "project-2" })],
    ["invalid date", opaque({ createdAt: "not-a-date", id: "project-2" })],
    ["array payload", opaque([createdAt.toISOString(), "project-2"])],
    ["oversized id", opaque({ createdAt: createdAt.toISOString(), id: "x".repeat(129) })],
  ])("rejects a malformed cursor (%s)", (_label, value) => {
    expect(decodeProjectsCursor(value)).toBeNull();
  });

  it("builds a deterministic (createdAt desc, id desc) keyset filter", () => {
    expect(projectsKeysetFilter({ createdAt, id: "project-2" })).toEqual({
      OR: [
        { createdAt: { lt: createdAt } },
        { createdAt, id: { lt: "project-2" } },
      ],
    });
  });
});
