export class TransactionQueue {
  private readonly pending = new Map<string, Promise<unknown>>();

  enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key);
    if (existing !== undefined) return existing as Promise<T>;

    const current = operation().finally(() => {
      if (this.pending.get(key) === current) this.pending.delete(key);
    });
    this.pending.set(key, current);
    return current;
  }
}
