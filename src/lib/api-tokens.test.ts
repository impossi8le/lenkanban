import { describe, expect, it } from "vitest";
import { apiTokenOptionsSchema, generateApiToken, hashApiToken, parseApiToken } from "./api-tokens";

describe("API token metadata", () => {
  it("defaults to read-only with no expiry", () => {
    const value = generateApiToken();
    expect(value.scopes).toEqual([]);
    expect(value.expiresAt).toBeNull();
    expect(parseApiToken(value.token)).toEqual({ prefix: value.prefix });
    expect(hashApiToken(value.token)).toBe(value.hash);
  });
  it("retains validated scopes and expiry separately from the secret", () => {
    const expiresAt = new Date("2030-01-01T00:00:00Z");
    const token = generateApiToken({ scopes: ["request.create", "request.create", "board.create"], expiresAt });
    expect(token.scopes).toEqual(["request.create", "board.create"]);
    expect(token.expiresAt).toEqual(expiresAt);
    expect(apiTokenOptionsSchema.parse({ scopes: ["request.move"], expiresAt: expiresAt.toISOString() })).toEqual({ scopes: ["request.move"], expiresAt });
  });
  it.each([{ scopes: ["*女"] }, { scopes: ["admin"] }, { expiresAt: "invalid" }])("rejects invalid metadata %j", input => {
    expect(apiTokenOptionsSchema.safeParse(input).success).toBe(false);
  });
});
