import { isRpcProviderId, RPC_PROVIDER_IDS, type RpcProviderId } from '../../domain/rpc-provider.js';
import {
  createRuntimeRpcHttpRoleEvidence,
  RPC_HTTP_ROLES,
  type RpcHttpRole,
  type RuntimeRpcHttpRoleEvidenceV1,
} from '../../domain/rpc-http-role-evidence.js';

const BUCKET_UPPER_BOUNDS = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, Infinity] as const;

interface Cell {
  readonly providerId: RpcProviderId;
  readonly role: RpcHttpRole;
  attempts: number;
  responses: number;
  http429Responses: number;
  failures: number;
  inFlight: number;
  maxInFlight: number;
  headerLatencyBuckets: number[];
  maxHeaderLatencyMs: number;
}

export interface RpcHttpRoleEvidenceRecorder {
  begin(providerId: RpcProviderId, role: RpcHttpRole): (status: number | null) => void;
  snapshot(): RuntimeRpcHttpRoleEvidenceV1;
}

export function createRpcHttpRoleEvidenceRecorder(
  options: { now?: () => number } = {},
): RpcHttpRoleEvidenceRecorder {
  const candidate: unknown = options;
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)
    || (options.now !== undefined && typeof options.now !== 'function')) {
    throw new TypeError('RPC HTTP role evidence clock is invalid.');
  }
  const now = options.now ?? ((): number => performance.now());
  const cells: Cell[] = RPC_PROVIDER_IDS.flatMap((providerId) => RPC_HTTP_ROLES.map((role) => ({
    providerId, role, attempts: 0, responses: 0, http429Responses: 0,
    failures: 0, inFlight: 0, maxInFlight: 0,
    headerLatencyBuckets: Array<number>(BUCKET_UPPER_BOUNDS.length).fill(0),
    maxHeaderLatencyMs: 0,
  })));
  let overflowed = false;
  const increment = (value: number): number => {
    if (value >= Number.MAX_SAFE_INTEGER) {
      overflowed = true;
      return Number.MAX_SAFE_INTEGER;
    }
    return value + 1;
  };
  const readTime = (): number => {
    try { return now(); } catch { overflowed = true; return NaN; }
  };
  return {
    begin(providerId, role) {
      if (!isRpcProviderId(providerId) || !RPC_HTTP_ROLES.includes(role)) {
        throw new TypeError('RPC HTTP role evidence target is invalid.');
      }
      const cell = cells[RPC_PROVIDER_IDS.indexOf(providerId) * RPC_HTTP_ROLES.length
        + RPC_HTTP_ROLES.indexOf(role)];
      if (cell === undefined) throw new TypeError('RPC HTTP role evidence target is invalid.');
      const start = readTime();
      cell.attempts = increment(cell.attempts);
      cell.inFlight = increment(cell.inFlight);
      cell.maxInFlight = Math.max(cell.maxInFlight, cell.inFlight);
      let finished = false;
      return (status) => {
        if (finished) return;
        finished = true;
        cell.inFlight = Math.max(0, cell.inFlight - 1);
        if (status === null) {
          cell.failures = increment(cell.failures);
          return;
        }
        cell.responses = increment(cell.responses);
        if (status === 429) cell.http429Responses = increment(cell.http429Responses);
        if (!Number.isSafeInteger(status) || status < 0) overflowed = true;
        const elapsed = readTime() - start;
        if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > Number.MAX_SAFE_INTEGER) {
          overflowed = true;
          return;
        }
        const duration = Math.ceil(elapsed);
        const bucket = BUCKET_UPPER_BOUNDS.findIndex((upper) => duration <= upper);
        if (bucket < 0) {
          overflowed = true;
          return;
        }
        cell.headerLatencyBuckets[bucket] = increment(cell.headerLatencyBuckets[bucket] ?? 0);
        cell.maxHeaderLatencyMs = Math.max(cell.maxHeaderLatencyMs, duration);
      };
    },
    snapshot(): RuntimeRpcHttpRoleEvidenceV1 {
      return createRuntimeRpcHttpRoleEvidence({
        version: 1, overflowed,
        entries: cells.map((cell) => ({
          providerId: cell.providerId, role: cell.role,
          attempts: cell.attempts, responses: cell.responses,
          http429Responses: cell.http429Responses, failures: cell.failures,
          inFlight: cell.inFlight, maxInFlight: cell.maxInFlight,
          headerLatencyBuckets: [...cell.headerLatencyBuckets],
          maxHeaderLatencyMs: cell.maxHeaderLatencyMs,
        })),
      });
    },
  };
}
