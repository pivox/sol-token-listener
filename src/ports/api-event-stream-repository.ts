import type { ApiSseEvent } from '../api/contracts.js';

export class ApiEventStreamCursorExpiredError extends Error {
  public constructor() {
    super('API event stream cursor has expired.');
    this.name = 'ApiEventStreamCursorExpiredError';
  }
}

export interface ApiStreamRevision {
  readonly sequence: bigint;
  readonly streamEventId: string;
  readonly event: ApiSseEvent;
}

export type StreamCursorResolution =
  | { readonly status: 'CURRENT'; readonly sequence: bigint }
  | { readonly status: 'EXPIRED' }
  | { readonly status: 'FUTURE' };

export interface ApiEventStreamRepository {
  highWaterMark(): Promise<bigint>;
  resolve(sequence: bigint): Promise<StreamCursorResolution>;
  readAfter(sequence: bigint, limit: number): Promise<readonly ApiStreamRevision[]>;
}
