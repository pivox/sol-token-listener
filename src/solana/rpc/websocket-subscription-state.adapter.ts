import type { Connection } from '@solana/web3.js';
import type { ProgramLogsConnection } from './program-subscriber.js';

/**
 * The acknowledgement hook is an internal web3.js API. package.json pins
 * @solana/web3.js to 1.98.4; keep that version dependency at this boundary.
 */
type Web3ConnectionWithSubscriptionState = Connection & {
  _onSubscriptionStateChange?: (
    clientSubscriptionId: number,
    callback: (state: string) => void,
  ) => () => void;
};

export class Web3ProgramLogsConnection implements ProgramLogsConnection {
  private readonly connection: Web3ConnectionWithSubscriptionState;

  public constructor(connection: Connection) {
    this.connection = connection;
  }

  public onLogs(
    filter: Parameters<Connection['onLogs']>[0],
    callback: Parameters<Connection['onLogs']>[1],
    commitment: 'processed',
  ): unknown {
    return this.connection.onLogs(filter, callback, commitment);
  }

  public watchSubscriptionState(
    id: number,
    callback: (state: string) => void,
  ): () => void {
    const watch = this.connection._onSubscriptionStateChange;
    if (typeof watch !== 'function') {
      throw new TypeError('Pinned web3.js subscription-state API is unavailable.');
    }
    return watch.call(this.connection, id, callback);
  }

  public removeOnLogsListener(id: number): Promise<void> {
    return this.connection.removeOnLogsListener(id);
  }
}
