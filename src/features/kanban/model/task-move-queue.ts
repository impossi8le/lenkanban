export class TaskMoveQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  enqueue<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(taskId);
    const current = previous
      ? previous.catch(() => undefined).then(operation)
      : Promise.resolve().then(operation);

    this.tails.set(taskId, current);

    return current.finally(() => {
      if (this.tails.get(taskId) === current) {
        this.tails.delete(taskId);
      }
    });
  }
}
