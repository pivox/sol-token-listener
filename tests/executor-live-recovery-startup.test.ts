import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LIVE_RECOVERY_EFFECTIVE_PRIVILEGES_SQL,
  LIVE_RECOVERY_MIGRATION_CATALOG,
  LiveRecoveryStartupError,
  validateLiveRecoveryStartup,
  validateLiveRecoveryMigrationFiles,
} from '../src/executor-live-recovery/startup-validator.js';
import { LIVE_RECOVERY_DATABASE_AUTHORITY } from
  '../src/executor-live-recovery/database-authority.js';
import type { LiveRecoveryConfig } from '../src/executor-live-recovery/config.js';

const GENERATION_ID = `execution_wallet_generation_${'a'.repeat(64)}`;
const PUBLIC_KEY = '11111111111111111111111111111111';

void test('pins every migration through 037 to a non-placeholder sha256', async () => {
  assert.equal(LIVE_RECOVERY_MIGRATION_CATALOG.length, 37);
  assert.equal(
    LIVE_RECOVERY_MIGRATION_CATALOG.at(-1)?.name,
    '037_execution_live_orchestration.sql',
  );
  for (const entry of LIVE_RECOVERY_MIGRATION_CATALOG) {
    assert.match(entry.name, /^\d{3}_[a-z0-9_-]+\.sql$/u);
    assert.match(entry.sha256, /^[0-9a-f]{64}$/u);
    assert.notEqual(entry.sha256, '0'.repeat(64));
    assert.equal(Object.isFrozen(entry), true);
  }
  assert.equal(Object.isFrozen(LIVE_RECOVERY_MIGRATION_CATALOG), true);
  await validateLiveRecoveryMigrationFiles();
});

void test('validates role, exact migration history, generation and open-work affinity in order', async () => {
  const calls: string[] = [];
  const database = databaseFor(calls);
  const evidence = await validateLiveRecoveryStartup(database, config());
  assert.deepEqual(calls, ['role', 'privileges', 'migrations', 'generation', 'work']);
  assert.deepEqual(evidence, {
    payloadVersion: 1,
    role: 'sol_token_executor_live_recovery',
    migrationHead: '037_execution_live_orchestration.sql',
    generationId: GENERATION_ID,
    providerId: 'primary',
  });
  assert.equal(Object.isFrozen(evidence), true);
});

void test('fails closed on role capabilities, migration drift, generation drift and open-work drift', async () => {
  const cases = [
    databaseFor([], { role: 'postgres' }),
    databaseFor([], { serverVersionNumber: 150_000 }),
    databaseFor([], { roleSuper: true }),
    databaseFor([], { roleLogin: true }),
    databaseFor([], { roleInherit: true }),
    databaseFor([], { sessionRole: 'sol_token_executor_live_recovery' }),
    databaseFor([], { sessionLogin: false }),
    databaseFor([], { sessionInherit: true }),
    databaseFor([], { membershipCount: '2' }),
    databaseFor([], { recoveryMembership: false }),
    databaseFor([], { membershipAdmin: true }),
    databaseFor([], { membershipInherit: true }),
    databaseFor([], { membershipSet: false }),
    databaseFor([], { recoveryParentCount: '1' }),
    databaseFor([], { sessionDirectAuthorityCount: '1' }),
    databaseFor([], { executableSecurityDefinerCount: '1' }),
    databaseFor([], { stateTransitionExecutable: false }),
    databaseFor([], { submissionTransitionExecutable: false }),
    databaseFor([], { recoveryCanSetReplicationRole: true }),
    databaseFor([], { sessionCanSetReplicationRole: true }),
    databaseFor([], { canReadSignedBytes: true }),
    databaseFor([], { canInsertSignedTransaction: true }),
    databaseFor([], { canUpdateSubmissionStarted: true }),
    databaseFor([], { canInsertSignedSimulation: true }),
    databaseFor([], { canInsertPreflight: true }),
    databaseFor([], { privileges: [] }),
    databaseFor([], { privileges: [...privilegeRows(), {
      kind: 'TABLE', object_name: 'execution_intents', subobject_name: null,
      privilege: 'DELETE', is_grantable: false,
    }] }),
    databaseFor([], { migrations: LIVE_RECOVERY_MIGRATION_CATALOG.slice(0, -1).map((item) => item.name) }),
    databaseFor([], { migrations: [...LIVE_RECOVERY_MIGRATION_CATALOG.map((item) => item.name), '999_unknown.sql'] }),
    databaseFor([], { generationWallet: 'Vote111111111111111111111111111111111111111' }),
    databaseFor([], { generationRetired: '2026-09-04T00:00:00.000Z' }),
    databaseFor([], { divergentWork: '1' }),
  ];
  const expected = [
    ...Array.from({ length: 27 }, () => 'DATABASE_ROLE_INVALID'),
    'MIGRATION_HISTORY_INVALID',
    'MIGRATION_HISTORY_INVALID', 'GENERATION_BINDING_INVALID',
    'GENERATION_BINDING_INVALID', 'OPEN_WORK_BINDING_INVALID',
  ];
  for (const [index, database] of cases.entries()) {
    await assert.rejects(
      validateLiveRecoveryStartup(database, config(), { validateFiles: false }),
      (error: unknown) => error instanceof LiveRecoveryStartupError
        && error.code === expected[index],
    );
  }
});

void test('wraps database failures without leaking their message', async () => {
  await assert.rejects(
    validateLiveRecoveryStartup({
      query: () => Promise.reject(new Error('postgresql://secret@database')),
    }, config(), { validateFiles: false }),
    (error: unknown) => error instanceof LiveRecoveryStartupError
      && error.code === 'DATABASE_READ_FAILED'
      && !error.message.includes('secret'),
  );
});

void test('rejects an otherwise allowed privilege when it is grantable', async () => {
  const privileges = privilegeRows().map((row, index) => ({
    ...row,
    is_grantable: index === 0,
  }));
  await assert.rejects(
    validateLiveRecoveryStartup(
      databaseFor([], { privileges }),
      config(),
      { validateFiles: false },
    ),
    (error: unknown) => error instanceof LiveRecoveryStartupError
      && error.code === 'DATABASE_ROLE_INVALID',
  );
});

void test('scans effective authority across every non-system schema', () => {
  assert.doesNotMatch(
    LIVE_RECOVERY_EFFECTIVE_PRIVILEGES_SQL,
    /namespace\.nspname='public'/u,
  );
  assert.match(
    LIVE_RECOVERY_EFFECTIVE_PRIVILEGES_SQL,
    /relation\.schema_name \|\| '\.' \|\| relation\.relname/u,
  );
  assert.match(
    LIVE_RECOVERY_EFFECTIVE_PRIVILEGES_SQL,
    /namespace\.nspname NOT IN \('pg_catalog','information_schema','pg_toast'\)/u,
  );
  assert.match(LIVE_RECOVERY_EFFECTIVE_PRIVILEGES_SQL, /NOT LIKE 'pg_temp_%'/u);
  assert.match(LIVE_RECOVERY_EFFECTIVE_PRIVILEGES_SQL, /NOT LIKE 'pg_toast_temp_%'/u);
});

interface Overrides {
  readonly serverVersionNumber?: number;
  readonly role?: string;
  readonly roleSuper?: boolean;
  readonly roleLogin?: boolean;
  readonly roleInherit?: boolean;
  readonly sessionRole?: string;
  readonly sessionLogin?: boolean;
  readonly sessionInherit?: boolean;
  readonly membershipCount?: string;
  readonly recoveryMembership?: boolean;
  readonly membershipAdmin?: boolean;
  readonly membershipInherit?: boolean;
  readonly membershipSet?: boolean;
  readonly recoveryParentCount?: string;
  readonly sessionDirectAuthorityCount?: string;
  readonly executableSecurityDefinerCount?: string;
  readonly stateTransitionExecutable?: boolean;
  readonly submissionTransitionExecutable?: boolean;
  readonly recoveryCanSetReplicationRole?: boolean;
  readonly sessionCanSetReplicationRole?: boolean;
  readonly canReadSignedBytes?: boolean;
  readonly canInsertSignedTransaction?: boolean;
  readonly canUpdateSubmissionStarted?: boolean;
  readonly canInsertSignedSimulation?: boolean;
  readonly canInsertPreflight?: boolean;
  readonly privileges?: readonly Readonly<Record<string, unknown>>[];
  readonly migrations?: readonly string[];
  readonly generationWallet?: string;
  readonly generationRetired?: string | null;
  readonly divergentWork?: string;
}

function databaseFor(calls: string[], overrides: Overrides = {}) {
  return {
    async query(text: string, values?: readonly unknown[]) {
      if (text.includes('live_recovery_effective_privileges')) {
        calls.push('privileges');
        const rows = overrides.privileges ?? privilegeRows();
        return { rows, rowCount: rows.length };
      }
      if (text.includes('current_user')) {
        calls.push('role');
        return result({
          server_version_number: overrides.serverVersionNumber ?? 160_000,
          current_role: overrides.role ?? 'sol_token_executor_live_recovery',
          session_role: overrides.sessionRole ?? 'sol_token_executor_live_recovery_login',
          role_super: overrides.roleSuper ?? false,
          role_login: overrides.roleLogin ?? false,
          role_inherit: overrides.roleInherit ?? false,
          role_createdb: false,
          role_createrole: false,
          role_bypass_rls: false,
          role_replication: false,
          session_super: false,
          session_login: overrides.sessionLogin ?? true,
          session_inherit: overrides.sessionInherit ?? false,
          session_createdb: false,
          session_createrole: false,
          session_bypass_rls: false,
          session_replication: false,
          membership_count: overrides.membershipCount ?? '1',
          recovery_membership: overrides.recoveryMembership ?? true,
          membership_admin: overrides.membershipAdmin ?? false,
          membership_inherit: overrides.membershipInherit ?? false,
          membership_set: overrides.membershipSet ?? true,
          recovery_parent_count: overrides.recoveryParentCount ?? '0',
          session_direct_authority_count: overrides.sessionDirectAuthorityCount ?? '0',
          executable_security_definer_count:
            overrides.executableSecurityDefinerCount ?? '0',
          state_transition_executable: overrides.stateTransitionExecutable ?? true,
          submission_transition_executable:
            overrides.submissionTransitionExecutable ?? true,
          recovery_can_set_replication_role:
            overrides.recoveryCanSetReplicationRole ?? false,
          session_can_set_replication_role:
            overrides.sessionCanSetReplicationRole ?? false,
          can_read_signed_bytes: overrides.canReadSignedBytes ?? false,
          can_insert_signed_transaction: overrides.canInsertSignedTransaction ?? false,
          can_update_submission_started: overrides.canUpdateSubmissionStarted ?? false,
          can_insert_signed_simulation: overrides.canInsertSignedSimulation ?? false,
          can_insert_preflight: overrides.canInsertPreflight ?? false,
        });
      }
      if (text.includes('migration_history')) {
        calls.push('migrations');
        return {
          rows: (overrides.migrations ?? LIVE_RECOVERY_MIGRATION_CATALOG.map((item) => item.name))
            .map((version) => ({ version })),
          rowCount: LIVE_RECOVERY_MIGRATION_CATALOG.length,
        };
      }
      if (text.includes('FROM execution_wallet_generations')) {
        calls.push('generation');
        assert.deepEqual(values, [GENERATION_ID]);
        return result({
          generation_id: GENERATION_ID,
          wallet_public_key: overrides.generationWallet ?? PUBLIC_KEY,
          cluster: 'mainnet-beta',
          genesis_hash: PUBLIC_KEY,
          retired_at: overrides.generationRetired ?? null,
        });
      }
      if (text.includes('divergent_work_count')) {
        calls.push('work');
        assert.deepEqual(values, [GENERATION_ID, PUBLIC_KEY, 'primary']);
        return result({ divergent_work_count: overrides.divergentWork ?? '0' });
      }
      throw new Error('Unexpected query.');
    },
  };
}

function result(row: Readonly<Record<string, unknown>>) {
  return { rows: [row], rowCount: 1 };
}

function privilegeRows(): readonly Readonly<Record<string, unknown>>[] {
  const rows: Readonly<Record<string, unknown>>[] = [{
    kind: 'SCHEMA', object_name: LIVE_RECOVERY_DATABASE_AUTHORITY.schema,
    subobject_name: null, privilege: 'USAGE', is_grantable: false,
  }];
  for (const table of LIVE_RECOVERY_DATABASE_AUTHORITY.tables) {
    for (const [privilege, columns] of [
      ['SELECT', table.select], ['INSERT', table.insert], ['UPDATE', table.update],
    ] as const) {
      for (const column of columns) rows.push({
        kind: 'COLUMN', object_name: `public.${table.name}`,
        subobject_name: column, privilege,
        is_grantable: false,
      });
    }
  }
  for (const sequence of LIVE_RECOVERY_DATABASE_AUTHORITY.sequences) {
    for (const privilege of sequence.privileges) rows.push({
      kind: 'SEQUENCE', object_name: `public.${sequence.name}`,
      subobject_name: null, privilege,
      is_grantable: false,
    });
  }
  return rows.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function config(): LiveRecoveryConfig {
  return Object.freeze({
    mode: 'live', recoveryEnabled: true, cluster: 'mainnet-beta',
    databaseUrl: 'postgresql://ignored', pollMs: 1_000, leaseMs: 60_000,
    databaseStatementTimeoutMs: 3_000, shutdownGraceMs: 10_000,
    generationId: GENERATION_ID, executorPublicKey: PUBLIC_KEY,
    providerId: 'primary', httpRpcUrl: 'https://rpc.example.test',
    expectedGenesisHash: PUBLIC_KEY, rpcTimeoutMs: 5_000,
    maxRpcCallsPerPass: 8, ownerId: 'recovery-a',
  });
}
