import { describe, expect, it } from "vitest";
import { createBase36RankService } from "../rank/rank-service";
import {
  allocateAppendRank,
  createAppendTaskRankPort,
  type AppendTaskRankPort,
  type TaskRankClient,
} from "./append-task-rank";

describe("append task rank allocation", () => {
  const ranks = createBase36RankService();

  it("allocates between both open boundaries for an empty column", async () => {
    const port: AppendTaskRankPort = {
      async lockColumn() {},
      async getLastRank() {
        return null;
      },
      async rebalanceColumn() {
        throw new Error("empty columns must not rebalance");
      },
    };

    await expect(
      allocateAppendRank({ columnId: "column-1", port, ranks }),
    ).resolves.toBe("0|HZZZZZZZZZZZZZZZZZZZ");
  });

  it("allocates between the last task and the open upper boundary", async () => {
    const port: AppendTaskRankPort = {
      async lockColumn() {},
      async getLastRank() {
        return "0|HZZZZZZZZZZZZZZZZZZZ";
      },
      async rebalanceColumn() {
        throw new Error("available columns must not rebalance");
      },
    };

    await expect(
      allocateAppendRank({ columnId: "column-1", port, ranks }),
    ).resolves.toBe("0|QZZZZZZZZZZZZZZZZZZZ");
  });

  it("rebalances once and recalculates when upper rank space is exhausted", async () => {
    let rebalanceCount = 0;
    const port: AppendTaskRankPort = {
      async lockColumn() {},
      async getLastRank() {
        return "0|ZZZZZZZZZZZZZZZZZZZY";
      },
      async rebalanceColumn(columnId) {
        expect(columnId).toBe("column-1");
        rebalanceCount += 1;
        return ["0|HZZZZZZZZZZZZZZZZZZZ"];
      },
    };

    await expect(
      allocateAppendRank({ columnId: "column-1", port, ranks }),
    ).resolves.toBe("0|QZZZZZZZZZZZZZZZZZZZ");
    expect(rebalanceCount).toBe(1);
  });

  it.each(["", "   ", undefined])(
    "rejects missing or blank column ID %o",
    async (columnId) => {
      const port: AppendTaskRankPort = {
        async lockColumn() {},
        async getLastRank() {
          throw new Error("invalid input must not query ranks");
        },
        async rebalanceColumn() {
          throw new Error("invalid input must not rebalance");
        },
      };

      await expect(
        allocateAppendRank({
          columnId: columnId as string,
          port,
          ranks,
        }),
      ).rejects.toThrow("columnId is required");
    },
  );

  it("rebalances persisted column ranks through the task-rank port", async () => {
    const persisted = [
      { id: "task-1", columnId: "column-1", rank: "0|NZZZZZZZZZZZZZZZZZZY" },
      { id: "task-2", columnId: "column-1", rank: "0|ZZZZZZZZZZZZZZZZZZZY" },
    ];
    const client: TaskRankClient = {
      async $queryRaw() {
        return [{ id: "column-1", projectId: "project-1" }];
      },
      task: {
        async findFirst({ where }) {
          return (
            persisted
              .filter((task) => task.columnId === where.columnId)
              .toSorted((left, right) => right.rank.localeCompare(left.rank))[0] ??
            null
          );
        },
        async findMany({ where }) {
          return persisted
            .filter((task) => task.columnId === where.columnId)
            .toSorted((left, right) => left.rank.localeCompare(right.rank))
            .map(({ id }) => ({ id }));
        },
        async update({ where, data }) {
          const task = persisted.find((candidate) => candidate.id === where.id);
          if (!task) {
            throw new Error("task not found");
          }
          if (
            persisted.some(
              (candidate) =>
                candidate.id !== task.id && candidate.rank === data.rank,
            )
          ) {
            throw new Error("duplicate rank");
          }
          task.rank = data.rank;
          return { id: task.id };
        },
      },
    };
    const port = createAppendTaskRankPort(client, ranks);

    await expect(port.getLastRank("column-1")).resolves.toBe(
      "0|ZZZZZZZZZZZZZZZZZZZY",
    );
    await expect(port.rebalanceColumn("column-1")).resolves.toEqual([
      "0|BZZZZZZZZZZZZZZZZZZZ",
      "0|NZZZZZZZZZZZZZZZZZZY",
    ]);
    expect(persisted.map((task) => task.rank)).toEqual([
      "0|BZZZZZZZZZZZZZZZZZZZ",
      "0|NZZZZZZZZZZZZZZZZZZY",
    ]);
  });

  it("acquires the transaction column lock before reading the last rank", async () => {
    const events: string[] = [];
    let releaseLock: (() => void) | undefined;
    const lockGate = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const client: TaskRankClient = {
      async $queryRaw(query) {
        const sql = query.join("?");
        if (
          sql.includes('FROM "ProjectColumn"') &&
          !sql.includes("FOR UPDATE")
        ) {
          events.push("read:column-project");
          return [{ id: "column-1", projectId: "project-1" }];
        }
        if (sql.includes('FROM "Project"')) {
          events.push("lock:start");
          await lockGate;
          events.push("lock:end");
          return [{ id: "project-1" }];
        }
        events.push("lock:column");
        return [{ id: "column-1", projectId: "project-1" }];
      },
      task: {
        async findFirst() {
          events.push("read:last-rank");
          return null;
        },
        async findMany() {
          return [];
        },
        async update() {
          return {};
        },
      },
    };
    const port = createAppendTaskRankPort(client, ranks);

    const allocation = allocateAppendRank({
      columnId: "column-1",
      port,
      ranks,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["read:column-project", "lock:start"]);

    releaseLock?.();
    await expect(allocation).resolves.toBe("0|HZZZZZZZZZZZZZZZZZZZ");
    expect(events).toEqual([
      "read:column-project",
      "lock:start",
      "lock:end",
      "lock:column",
      "read:last-rank",
    ]);
  });

  it("locks project then revalidates the column before reading ranks", async () => {
    const events: string[] = [];
    const client: TaskRankClient = {
      async $queryRaw(query) {
        const sql = query.join("?");
        if (
          sql.includes('FROM "ProjectColumn"') &&
          !sql.includes("FOR UPDATE")
        ) {
          events.push("read:column-project");
          return [{ id: "column-1", projectId: "project-1" }];
        }
        if (sql.includes('FROM "Project"')) {
          events.push("lock:project");
          return [{ id: "project-1" }];
        }
        events.push("lock:column");
        return [{ id: "column-1", projectId: "project-1" }];
      },
      task: {
        async findFirst() {
          events.push("read:last-rank");
          return null;
        },
        async findMany() {
          return [];
        },
        async update() {
          return {};
        },
      },
    };
    const port = createAppendTaskRankPort(client, ranks);

    await allocateAppendRank({
      columnId: "column-1",
      port,
      ranks,
    });

    expect(events).toEqual([
      "read:column-project",
      "lock:project",
      "lock:column",
      "read:last-rank",
    ]);
  });
});
