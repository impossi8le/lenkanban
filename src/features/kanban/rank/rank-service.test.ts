import { describe, expect, it } from "vitest";
import {
  createBase36RankService,
  formatRank,
  RANK_MAX,
} from "./rank-service";

describe("base36 rank service", () => {
  const ranks = createBase36RankService();

  it("creates a rank strictly between adjacent ranks", () => {
    const previous = "0|0000000000000000000A";
    const next = "0|0000000000000000000C";
    expect(ranks.between(previous, next)).toBe("0|0000000000000000000B");
  });

  it("returns null when no integer gap remains", () => {
    expect(
      ranks.between(
        "0|0000000000000000000A",
        "0|0000000000000000000B",
      ),
    ).toBeNull();
  });

  it("rebalances tasks into deterministic ascending ranks", () => {
    const result = ranks.rebalance(["a", "b", "c"]);
    expect([...result.keys()]).toEqual(["a", "b", "c"]);
    expect([...result.values()]).toEqual(
      [...result.values()].toSorted(),
    );
    expect(new Set(result.values()).size).toBe(3);
  });

  it("rejects malformed or non-canonical ranks", () => {
    expect(() => ranks.between("a0", null)).toThrow("Invalid task rank");
    expect(() => ranks.between("0|0000000000000000000a", null)).toThrow(
      "Invalid task rank",
    );
  });

  it("formats the fixed lower boundary without losing width", () => {
    expect(formatRank(0n)).toBe("0|00000000000000000000");
  });

  it("rejects a rank value below the fixed lower boundary", () => {
    expect(() => formatRank(-1n)).toThrow("Invalid task rank");
  });

  it("rejects a rank value above the fixed upper boundary", () => {
    expect(() => formatRank(RANK_MAX + 1n)).toThrow("Invalid task rank");
  });
});
