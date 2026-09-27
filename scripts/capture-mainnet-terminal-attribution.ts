import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { lstat, open, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { QueryResultRow } from 'pg';
import {
  MAINNET_TERMINAL_ATTRIBUTION_MAX_BYTES,
  buildMainnetTerminalAttribution,
  serializeMainnetTerminalAttribution,
  type MainnetTerminalAttributionV1,
} from './lib/mainnet-terminal-attribution.js';

const FIXED_ERROR = 'MAINNET_TERMINAL_ATTRIBUTION_CAPTURE_FAILED\n';

const STOPPED_SQL = `SELECT runtime_state,subscriber_state,scanner_state,worker_state,
  reconciler_state,leased_transactions
FROM listener_heartbeats WHERE service_key='transaction-listener'`;

const CURRENT_POPULATION_SQL = `SELECT processing_status,error_name,error_retryable,
  CASE
    WHEN processing_status='FAILED' AND error_retryable=TRUE
      AND retry_exhausted_at IS NULL THEN 'RETRY_PENDING'
    ELSE 'TERMINAL'
  END AS failure_state,
  attempts,attempts_in_cycle,catch_up_reason_code,COUNT(*)::TEXT AS row_count
FROM chain_transaction_inbox
WHERE processing_status IN ('FAILED','QUARANTINED')
GROUP BY processing_status,error_name,error_retryable,failure_state,attempts,
  attempts_in_cycle,catch_up_reason_code`;

const DIAGNOSTIC_OCCURRENCES_SQL = `WITH ranked AS (
  SELECT source,processing_outcome,worker_cycle_attempt,worker_recovery_count,
    retryable,retry_exhausted,stage,origin,diagnostic_code,catch_up_cause_kind,
    catch_up_reason_code,completeness,wire_surface,wire_location,
    wire_discriminator,wire_idl_name,wire_total_bytes,wire_payload_bytes,
    wire_suffix_bytes,signature,slot,transaction_index,confirmation_status,
    instruction_index,inner_instruction_index,
    COUNT(*) OVER (PARTITION BY source,processing_outcome,worker_cycle_attempt,
      worker_recovery_count,retryable,retry_exhausted,stage,origin,diagnostic_code,
      catch_up_cause_kind,catch_up_reason_code,completeness,wire_surface,
      wire_location,wire_discriminator,wire_idl_name,wire_total_bytes,
      wire_payload_bytes,wire_suffix_bytes)::TEXT AS occurrence_count,
    ROW_NUMBER() OVER (PARTITION BY source,processing_outcome,worker_cycle_attempt,
      worker_recovery_count,retryable,retry_exhausted,stage,origin,diagnostic_code,
      catch_up_cause_kind,catch_up_reason_code,completeness,wire_surface,
      wire_location,wire_discriminator,wire_idl_name,wire_total_bytes,
      wire_payload_bytes,wire_suffix_bytes
      ORDER BY signature COLLATE "C",slot,transaction_index NULLS FIRST,
        confirmation_status COLLATE "C",instruction_index NULLS FIRST,
        inner_instruction_index NULLS FIRST) AS representative_rank
  FROM transaction_inbox_terminal_attributions
)
SELECT source,processing_outcome,worker_cycle_attempt,worker_recovery_count,
  retryable,retry_exhausted,stage,origin,diagnostic_code,catch_up_cause_kind,
  catch_up_reason_code,completeness,wire_surface,wire_location,
  wire_discriminator,wire_idl_name,wire_total_bytes,wire_payload_bytes,
  wire_suffix_bytes,occurrence_count,
  CASE WHEN wire_surface IS NOT NULL THEN signature END AS representative_signature,
  CASE WHEN wire_surface IS NOT NULL THEN slot END AS representative_slot,
  CASE WHEN wire_surface IS NOT NULL THEN transaction_index END
    AS representative_transaction_index,
  CASE WHEN wire_surface IS NOT NULL THEN confirmation_status END
    AS representative_confirmation_status,
  CASE WHEN wire_surface IS NOT NULL THEN instruction_index END
    AS representative_instruction_index,
  CASE WHEN wire_surface IS NOT NULL THEN inner_instruction_index END
    AS representative_inner_instruction_index
FROM ranked WHERE representative_rank=1`;

const INCOMPLETE_ATTRIBUTION_SQL = `SELECT COUNT(*)::TEXT AS parent_count,
  COALESCE(SUM(terminal_attribution_incomplete_count),0)::TEXT AS incomplete_count
FROM chain_transaction_inbox
WHERE terminal_attribution_incomplete_count>0`;

export interface MainnetTerminalAttributionConnection {
  query(sql: string): Promise<{ readonly rows: readonly QueryResultRow[] }>;
  release?: (() => void) | undefined;
}

export interface MainnetTerminalAttributionCommandDependencies {
  readonly connect: () => Promise<MainnetTerminalAttributionConnection>;
  readonly close: () => Promise<void>;
  readonly writeArtifact: (path: string, bytes: string) => Promise<void>;
  readonly writeStdout: (value: string) => void;
  readonly writeStderr: (value: string) => void;
}

export interface ExclusiveWriteHooks {
  readonly afterOpen?: ((handle: FileHandle) => Promise<void>) | undefined;
}

export async function captureMainnetTerminalAttribution(
  connection: MainnetTerminalAttributionConnection,
): Promise<MainnetTerminalAttributionV1> {
  await connection.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const stopped = await connection.query(STOPPED_SQL);
    assertListenerStopped(stopped.rows);
    const current = await connection.query(CURRENT_POPULATION_SQL);
    const occurrences = await connection.query(DIAGNOSTIC_OCCURRENCES_SQL);
    const incomplete = await connection.query(INCOMPLETE_ATTRIBUTION_SQL);
    const artifact = buildMainnetTerminalAttribution({
      currentPopulationRows: current.rows,
      diagnosticOccurrenceRows: occurrences.rows,
      incompleteAttributionRows: incomplete.rows,
    });
    await connection.query('COMMIT');
    return artifact;
  } catch (error) {
    try {
      await connection.query('ROLLBACK');
    } catch {
      // The fixed CLI error remains deliberately independent from cleanup detail.
    }
    throw error;
  }
}

export async function runMainnetTerminalAttributionCommand(
  args: readonly string[],
  dependencies: MainnetTerminalAttributionCommandDependencies = createDefaultDependencies(),
): Promise<0 | 1> {
  if (args.length !== 1 || args[0] === undefined || args[0].length === 0) {
    dependencies.writeStderr(FIXED_ERROR);
    return 1;
  }
  let connection: MainnetTerminalAttributionConnection | null = null;
  let closed = false;
  try {
    connection = await dependencies.connect();
    const artifact = await captureMainnetTerminalAttribution(connection);
    connection.release?.();
    connection = null;
    await dependencies.close();
    closed = true;
    const bytes = serializeMainnetTerminalAttribution(artifact);
    await dependencies.writeArtifact(args[0], bytes);
    return 0;
  } catch {
    try {
      connection?.release?.();
    } catch {
      // Never expose connection cleanup detail.
    }
    if (!closed) {
      try {
        await dependencies.close();
      } catch {
        // Never expose database cleanup detail.
      }
    }
    dependencies.writeStderr(FIXED_ERROR);
    return 1;
  }
}

export async function writeMainnetTerminalAttributionExclusive(
  path: string,
  bytes: string,
  hooks: ExclusiveWriteHooks = {},
): Promise<void> {
  const byteCount = Buffer.byteLength(bytes, 'utf8');
  if (byteCount > MAINNET_TERMINAL_ATTRIBUTION_MAX_BYTES) throw new TypeError();
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
    | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const handle = await open(path, flags, 0o600);
  let createdIdentity: BigIntStats | null = null;
  let primaryFailure: unknown;
  try {
    createdIdentity = await handle.stat({ bigint: true });
    if (hooks.afterOpen === undefined) await handle.writeFile(bytes, 'utf8');
    else await hooks.afterOpen(handle);
    await handle.chmod(0o600);
    await handle.sync();
    const opened = await handle.stat({ bigint: true });
    const linked = await lstat(path, { bigint: true });
    if (!opened.isFile() || !linked.isFile() || !sameIdentity(opened, linked)
      || opened.size !== BigInt(byteCount) || (opened.mode & 0o777n) !== 0o600n
      || (typeof process.getuid === 'function' && opened.uid !== BigInt(process.getuid()))) {
      throw new TypeError();
    }
  } catch (error) {
    primaryFailure = error;
  }

  try {
    await handle.close();
  } catch (error) {
    if (primaryFailure === undefined) primaryFailure = error;
  }
  if (primaryFailure !== undefined) {
    if (createdIdentity !== null) await unlinkIfSameFile(path, createdIdentity);
    throw primaryFailure instanceof Error ? primaryFailure : new TypeError();
  }
}

function assertListenerStopped(rows: readonly QueryResultRow[]): void {
  if (rows.length !== 1) throw new TypeError();
  const row = rows[0];
  if (row?.runtime_state !== 'STOPPED'
    || row.subscriber_state !== 'STOPPED' || row.scanner_state !== 'STOPPED'
    || row.worker_state !== 'STOPPED' || row.reconciler_state !== 'STOPPED'
    || parseNonNegativeInteger(row.leased_transactions) !== 0) throw new TypeError();
}

function parseNonNegativeInteger(value: unknown): number {
  if (typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0
    || Object.is(value, -0)) throw new TypeError();
  return value;
}

async function unlinkIfSameFile(path: string, identity: BigIntStats): Promise<void> {
  try {
    const current = await lstat(path, { bigint: true });
    if (sameIdentity(identity, current)) await unlink(path);
  } catch {
    // Cleanup must never replace the primary failure or unlink a replaced path.
  }
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function createDefaultDependencies(): MainnetTerminalAttributionCommandDependencies {
  let pool: InstanceType<typeof pg.Pool> | null = null;
  return {
    async connect(): Promise<MainnetTerminalAttributionConnection> {
      const databaseUrl = process.env.DATABASE_URL;
      if (databaseUrl === undefined || databaseUrl.trim() === '') throw new TypeError();
      pool = new pg.Pool({ connectionString: databaseUrl });
      return pool.connect();
    },
    async close(): Promise<void> {
      const active = pool;
      pool = null;
      if (active !== null) await active.end();
    },
    writeArtifact: writeMainnetTerminalAttributionExclusive,
    writeStdout(value): void { process.stdout.write(value); },
    writeStderr(value): void { process.stderr.write(value); },
  };
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  process.exitCode = await runMainnetTerminalAttributionCommand(process.argv.slice(2));
}
