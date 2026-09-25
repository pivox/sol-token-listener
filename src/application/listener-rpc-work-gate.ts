import type { TransactionBlockRpc } from '../solana/rpc/transaction-locator.js';

export class ListenerRpcWorkGate {
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (typeof operation !== 'function') {
      return Promise.reject(new TypeError('RPC work operation must be a function'));
    }
    const result = this.tail.then(() => {
      if (this.closed) throw new ListenerRpcWorkGateClosedError();
      return operation();
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  close(): void {
    this.closed = true;
  }
}

export class ListenerRpcWorkGateClosedError extends Error {
  public constructor() {
    super('RPC work gate is closed.');
    this.name = 'ListenerRpcWorkGateClosedError';
    Object.freeze(this);
  }
}

/**
 * Gates only the physical block request. Cache lookup and in-flight joining must
 * remain outside this boundary so concurrent callers for one slot share a fetch.
 */
export function gateBlockTransactionRpc(
  gate: ListenerRpcWorkGate,
  rpc: TransactionBlockRpc,
): TransactionBlockRpc {
  return Object.freeze({
    getBlockTransactions(
      slot: bigint,
      confirmationStatus: Parameters<TransactionBlockRpc['getBlockTransactions']>[1],
      signal?: AbortSignal,
    ): Promise<unknown> {
      return gate.run(() => rpc.getBlockTransactions(slot, confirmationStatus, signal));
    },
  });
}
