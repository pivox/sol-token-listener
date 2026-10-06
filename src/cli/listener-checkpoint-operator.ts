import { Connection, PublicKey } from '@solana/web3.js';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import {
  CheckpointRebaseOperator,
  CheckpointRebaseRefusal,
  type CheckpointProgram,
  type CheckpointRebaseRpc,
} from '../application/checkpoint-rebase-operator.js';
import { PUMP_PROGRAM_ID } from '../launchpads/pumpfun/constants.js';
import { PUMPSWAP_PROGRAM_ID } from '../markets/pumpswap/constants.js';
import { PostgresCheckpointRebaseRepository } from '../storage/checkpoint-rebase.repository.js';

const programIds: Readonly<Record<CheckpointProgram, string>> = Object.freeze({
  launchpad: PUMP_PROGRAM_ID,
  market: PUMPSWAP_PROGRAM_ID,
});

type OperatorCommand =
  | { readonly action: 'inspect'; readonly confirmed: false }
  | { readonly action: 'rebase'; readonly program: CheckpointProgram;
      readonly reason: 'invalid-future-checkpoint'; readonly confirmed: boolean };

export function parseCheckpointOperatorCommand(args: readonly string[]): OperatorCommand {
  if (args.length === 1 && args[0] === 'inspect') {
    return Object.freeze({ action: 'inspect', confirmed: false });
  }
  if (args[0] !== 'rebase') throw new TypeError('Expected inspect or rebase command.');
  let program: CheckpointProgram | undefined;
  let reason: 'invalid-future-checkpoint' | undefined;
  let confirmed = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--program') {
      const value = args[++index];
      if (program !== undefined || (value !== 'launchpad' && value !== 'market')) {
        throw new TypeError('Specify exactly one supported --program.');
      }
      program = value;
    } else if (argument === '--reason') {
      const value = args[++index];
      if (reason !== undefined || value !== 'invalid-future-checkpoint') {
        throw new TypeError('Unsupported or duplicate --reason.');
      }
      reason = value;
    } else if (argument === '--confirm-invalid-checkpoint-rebase') {
      if (confirmed) throw new TypeError('Duplicate confirmation flag.');
      confirmed = true;
    } else {
      throw new TypeError('Unsupported checkpoint operator argument.');
    }
  }
  if (program === undefined || reason === undefined) {
    throw new TypeError('Rebase requires --program and --reason.');
  }
  return Object.freeze({ action: 'rebase', program, reason, confirmed });
}

async function main(args: readonly string[]): Promise<void> {
  let command: OperatorCommand;
  try {
    command = parseCheckpointOperatorCommand(args);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Invalid command.'}\n`);
    process.exitCode = 2;
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    process.stderr.write('Checkpoint operator requires DATABASE_URL from live.env.\n');
    process.exitCode = 2;
    return;
  }
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5_000 });
  const repository = new PostgresCheckpointRebaseRepository(pool);
  try {
    if (command.action === 'inspect') {
      const states = await Promise.all([
        repository.inspect('launchpad'),
        repository.inspect('market'),
      ]);
      process.stdout.write(`${JSON.stringify({
        event: 'listener.checkpoints.inspected',
        readOnly: true,
        programs: states.map((state) => ({
          program: state.checkpoint?.key ?? null,
          checkpoint: state.checkpoint === null ? null : {
            slot: state.checkpoint.slot.toString(), signature: state.checkpoint.signature,
            updatedAt: new Date(state.checkpoint.updatedAtMs).toISOString(),
          },
          latestRebaseGap: state.latestGap === null ? null : {
            previousSlot: state.latestGap.previousSlot.toString(),
            previousSignature: state.latestGap.previousSignature,
            newSlot: state.latestGap.newSlot.toString(),
            newSignature: state.latestGap.newSignature,
            finalizedHeadSlot: state.latestGap.finalizedHeadSlot.toString(),
            reason: state.latestGap.reason,
            recordedAt: new Date(state.latestGap.recordedAtMs).toISOString(),
          },
          auditTableAvailable: state.auditTableAvailable,
        })),
      })}\n`);
      return;
    }

    const httpUrl = process.env.SOLANA_HTTP_RPC_URL;
    const expectedGenesisHash = process.env.LIVE_EXPECTED_GENESIS_HASH;
    if (!httpUrl || !expectedGenesisHash) {
      process.stderr.write('Checkpoint rebase requires SOLANA_HTTP_RPC_URL and LIVE_EXPECTED_GENESIS_HASH.\n');
      process.exitCode = 2;
      return;
    }
    if ((process.env.SOLANA_CLUSTER ?? 'mainnet-beta') !== 'mainnet-beta') {
      process.stderr.write('Checkpoint rebase refused: SOLANA_CLUSTER must be mainnet-beta.\n');
      process.exitCode = 1;
      return;
    }
    const connection = new Connection(httpUrl, 'confirmed');
    const rpc: CheckpointRebaseRpc = Object.freeze({
      getGenesisHash: () => connection.getGenesisHash(),
      getFinalizedHead: async () => BigInt(await connection.getSlot('finalized')),
      getLatestFinalizedSignature: async (program: CheckpointProgram) => {
        const rows = await connection.getSignaturesForAddress(
          new PublicKey(programIds[program]), { limit: 1 }, 'finalized',
        );
        const row = rows[0];
        if (row?.confirmationStatus !== 'finalized') {
          throw new CheckpointRebaseRefusal('SIGNATURE_NOT_FINALIZED');
        }
        return Object.freeze({
          signature: row.signature,
          slot: BigInt(row.slot),
          confirmationStatus: 'finalized' as const,
        });
      },
    });
    const operator = new CheckpointRebaseOperator(repository, rpc);
    const result = await operator.execute(
      command.program, command.reason, command.confirmed, expectedGenesisHash,
    );
    process.stdout.write(`${JSON.stringify({
      event: `listener.checkpoint.rebase.${result.status.toLowerCase()}`,
      confirmed: command.confirmed,
      program: command.program,
      plan: result.status === 'ALREADY_APPLIED' ? {
        status: result.status,
        currentSlot: result.checkpoint.slot.toString(),
        currentSignature: result.checkpoint.signature,
      } : {
        previousSlot: result.plan.previous.slot.toString(),
        previousSignature: result.plan.previous.signature,
        newSlot: result.plan.next.slot.toString(),
        newSignature: result.plan.next.signature,
        finalizedHeadSlot: result.plan.finalizedHeadSlot.toString(),
        genesisHash: result.plan.genesisHash,
        reason: result.plan.reason,
      },
    })}\n`);
  } catch (error) {
    const rawCode = typeof error === 'object' && error !== null && 'code' in error
      ? (error as { readonly code?: unknown }).code : undefined;
    const code = error instanceof CheckpointRebaseRefusal ? error.code
      : typeof rawCode === 'string' || typeof rawCode === 'number' ? String(rawCode) : 'OPERATOR_ERROR';
    process.stderr.write(`${JSON.stringify({ event: 'listener.checkpoint.rebase.refused', code })}\n`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  void main(process.argv.slice(2)).catch(() => {
    process.stderr.write('{"event":"listener.checkpoint.operator.failed","code":"OPERATOR_ERROR"}\n');
    process.exitCode = 1;
  });
}
