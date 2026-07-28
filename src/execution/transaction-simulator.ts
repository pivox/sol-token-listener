import type { Connection, SimulateTransactionConfig } from '@solana/web3.js';
import type { BuiltTransaction, TransactionSimulation } from '../domain/types.js';

export interface TransactionSimulator {
  simulate(transaction: BuiltTransaction, signaturesVerified: boolean): Promise<TransactionSimulation>;
}

export class SolanaTransactionSimulator implements TransactionSimulator {
  constructor(private readonly connection: Connection) {}

  async simulate(built: BuiltTransaction, signaturesVerified: boolean): Promise<TransactionSimulation> {
    const options: SimulateTransactionConfig = {
      commitment: 'confirmed',
      sigVerify: signaturesVerified,
      replaceRecentBlockhash: !signaturesVerified,
    };
    const response = await this.connection.simulateTransaction(built.transaction, options);
    const error = response.value.err === null ? null : JSON.stringify(response.value.err);
    return {
      ok: response.value.err === null,
      error,
      logs: response.value.logs ?? [],
      unitsConsumed: response.value.unitsConsumed === undefined ? null : BigInt(response.value.unitsConsumed),
      replacementBlockhash: null,
    };
  }
}
