import type { ProcessingCheckpointKey } from '../domain/transaction-ingestion.js';

export type ListenerIngestionProgramFamily = 'pumpfun' | 'pumpswap';

export interface ListenerIngestionProgram {
  readonly key: ProcessingCheckpointKey;
  readonly family: ListenerIngestionProgramFamily;
  readonly id: string;
}
