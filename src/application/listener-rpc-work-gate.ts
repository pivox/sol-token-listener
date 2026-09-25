export class ListenerRpcWorkGate {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (typeof operation !== 'function') {
      return Promise.reject(new TypeError('RPC work operation must be a function'));
    }
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
