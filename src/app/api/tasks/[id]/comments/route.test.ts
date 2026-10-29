import { describe, expect, it } from "vitest";

import { GET, POST } from "./route";

describe("deprecated comments endpoint", () => {
  it.each([
    ["GET", GET],
    ["POST", POST],
  ] as const)("keeps %s closed with 410 so it cannot bypass discussion visibility", async (_method, handler) => {
    const response = await handler();
    expect(response.status).toBe(410);
    const body = await response.json();
    expect(body).toMatchObject({
      success: false,
      error: { code: "COMMENTS_DEPRECATED" },
    });
    expect(body).not.toHaveProperty("data");
  });
});
