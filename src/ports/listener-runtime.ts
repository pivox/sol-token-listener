import type { ListenerRuntimeState } from '../domain/transaction-ingestion.js';
import type { ApiProjectionPipelineState } from '../storage/api-projection.repository.js';

export interface ListenerRuntime {
  start(): Promise<void>;
  close(): Promise<void>;
  state(): ListenerRuntimeState;
  pipelineState(): ApiProjectionPipelineState;
}
