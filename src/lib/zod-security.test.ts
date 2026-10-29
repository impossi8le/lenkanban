import { expect, it } from "vitest";
import { z } from "zod";
import { apiValidationError } from "./api-response";

// Eight tiny synthetic elements exercise the upstream early-size gate without
// allocating a large payload or testing process exhaustion.
it("rejects an oversized constrained array before visiting its elements", () => {
  let visits = 0;
  const element = z.string().refine(() => { visits++; return true; });
  const result = z.array(element).max(2).safeParse(Array(8).fill("synthetic"));
  expect(result.success).toBe(false);
  expect(visits).toBe(0);
  if (!result.success) expect(result.error.issues).toMatchObject([{ code: "too_big", path: [] }]);
});

it("applies the early gate to exact array lengths and async parsing", async () => {
  let visits = 0;
  const element = z.string().refine(() => { visits++; return true; });
  const result = await z.array(element).length(2).safeParseAsync(["one", "two", "three"]);
  expect(result.success).toBe(false);
  expect(visits).toBe(0);
  if (!result.success) expect(result.error.issues).toHaveLength(1);
});

it("reports one nested collection bound instead of an issue per invalid element", () => {
  const result = z.object({ taskIds: z.array(z.string()).max(2) }).safeParse({ taskIds: [1, 2, 3] });
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0]).toMatchObject({ code: "too_big", path: ["taskIds"] });
  }
});

it("still validates elements inside the bound and preserves successful values", () => {
  const schema = z.array(z.string()).max(2);
  expect(schema.parse(["one", "two"])).toEqual(["one", "two"]);
  const invalid = schema.safeParse([1]);
  expect(invalid.success).toBe(false);
  if (!invalid.success) expect(invalid.error.issues[0]).toMatchObject({ code: "invalid_type", path: [0] });
});

it("keeps the API validation response at422 with stable field paths and no raw input", async () => {
  const result = z.object({ name: z.string().min(2, "Too short") }).safeParse({ name: "x" });
  if (result.success) throw new Error("Expected a synthetic validation failure");
  const response = apiValidationError(result.error);
  expect(response.status).toBe(422);
  expect(await response.json()).toEqual({ success: false, error: {
    code: "VALIDATION_ERROR", message: "Validation failed", details: [{ path: "name", message: "Too short" }],
  } });
});
