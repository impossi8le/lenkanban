import { describe, expect, it } from "vitest";
import { TaskMoveQueue } from "./task-move-queue";

class BrokenCleanupQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  enqueue<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(taskId);
    const current = previous
      ? previous.catch(() => undefined).then(operation)
      : Promise.resolve().then(operation);

    this.tails.set(taskId, current);

    return current.finally(() => {
      this.tails.delete(taskId);
    });
  }
}

describe("TaskMoveQueue", () => {
  it("runs commands for the same task serially", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const queue = new TaskMoveQueue();

    const first = queue.enqueue("task-a", async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
    });
    const second = queue.enqueue("task-a", async () => {
      events.push("second:start");
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("starts different task operations before either is released", async () => {
    const queue = new TaskMoveQueue();
    const events: string[] = [];
    let releaseA!: () => void;
    let releaseB!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });

    const operations = [
      queue.enqueue("a", async () => {
        events.push("a:start");
        await gateA;
        events.push("a:end");
      }),
      queue.enqueue("b", async () => {
        events.push("b:start");
        await gateB;
        events.push("b:end");
      }),
    ];

    await Promise.resolve();
    expect(events).toEqual(["a:start", "b:start"]);
    releaseA();
    releaseB();
    await Promise.all(operations);
    expect(new Set(events)).toEqual(new Set(["a:start", "a:end", "b:start", "b:end"]));
  });

  it("continues a task queue after a rejected command", async () => {
    const queue = new TaskMoveQueue();
    const events: string[] = [];

    const first = queue.enqueue("task-a", async () => {
      events.push("first");
      throw new Error("request failed");
    });
    const second = queue.enqueue("task-a", async () => {
      events.push("second");
    });

    await expect(first).rejects.toThrow("request failed");
    await second;
    expect(events).toEqual(["first", "second"]);
  });

  it("demonstrates that the local broken cleanup control starts a third operation early", async () => {
    const queue = new BrokenCleanupQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    const first = queue.enqueue("task-a", async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
    });
    const second = queue.enqueue("task-a", async () => {
      events.push("second:start");
      await secondGate;
      events.push("second:end");
    });

    await Promise.resolve();
    releaseFirst();
    await first;
    const third = queue.enqueue("task-a", async () => {
      events.push("third:start");
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start", "first:end", "second:start", "third:start"]);
    releaseSecond();
    await Promise.all([second, third]);
  });

  it("keeps the third operation queued while the second operation owns the tail", async () => {
    const queue = new TaskMoveQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    const first = queue.enqueue("task-a", async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
    });
    const second = queue.enqueue("task-a", async () => {
      events.push("second:start");
      await secondGate;
      events.push("second:end");
    });

    await Promise.resolve();
    releaseFirst();
    await first;
    const third = queue.enqueue("task-a", async () => {
      events.push("third:start");
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
    releaseSecond();
    await Promise.all([second, third]);
    expect(events).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
      "third:start",
    ]);
  });
});
