export interface RankService {
  between(previous: string | null, next: string | null): string | null;
  rebalance(taskIdsInOrder: readonly string[]): ReadonlyMap<string, string>;
}

export const RANK_BUCKET = "0";
export const RANK_WIDTH = 20;
export const RANK_BASE = 36n;
export const RANK_MAX = RANK_BASE ** BigInt(RANK_WIDTH) - 1n;

const rankPattern = /^0\|[0-9A-Z]{20}$/;

export function formatRank(value: bigint): string {
  if (value < 0n || value > RANK_MAX) {
    throw new Error("Invalid task rank");
  }

  return `${RANK_BUCKET}|${value
    .toString(Number(RANK_BASE))
    .toUpperCase()
    .padStart(RANK_WIDTH, "0")}`;
}

export function parseRank(rank: string): bigint {
  if (!rankPattern.test(rank)) {
    throw new Error("Invalid task rank");
  }

  return [...rank.slice(RANK_BUCKET.length + 1)].reduce(
    (value, character) => value * RANK_BASE + BigInt(parseInt(character, 36)),
    0n,
  );
}

export function createBase36RankService(): RankService {
  return {
    between(previous, next) {
      const lower = previous === null ? 0n : parseRank(previous);
      const upper = next === null ? RANK_MAX : parseRank(next);
      const midpoint = (lower + upper) / 2n;

      if (midpoint === lower || midpoint === upper) {
        return null;
      }

      return formatRank(midpoint);
    },
    rebalance(taskIdsInOrder) {
      const taskCount = taskIdsInOrder.length;
      const step = RANK_MAX / BigInt(taskCount + 1);

      return new Map(
        taskIdsInOrder.map((taskId, index) => [
          taskId,
          formatRank(step * BigInt(index + 1)),
        ]),
      );
    },
  };
}
