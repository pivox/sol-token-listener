import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { LiveExecutorConfig } from '../src/executor-live/config.js';
import {
  LIVE_EXECUTOR_DATABASE_AUTHORITY_V1,
  LIVE_EXECUTOR_EFFECTIVE_AUTHORITY_SQL,
  LIVE_EXECUTOR_MIGRATION_CATALOG,
  LiveExecutorStartupError,
  validateLiveExecutorMigrationFiles,
  validateLiveExecutorStartup,
} from '../src/executor-live/startup-validator.js';

const GENERATION_ID = `execution_wallet_generation_${'a'.repeat(64)}`;
const PUBLIC_KEY = '11111111111111111111111111111111';
const FINGERPRINT = 'b'.repeat(64);

void test('pins the existing migration catalogue and rejects a changed migration hash', async () => {
  assert.equal(LIVE_EXECUTOR_MIGRATION_CATALOG.length, 39);
  assert.equal(LIVE_EXECUTOR_MIGRATION_CATALOG.at(-1)?.name,
    '039_execution_canary_operator_binding.sql');
  await validateLiveExecutorMigrationFiles();

  const directory = await mkdtemp(join(tmpdir(), 'executor-live-migrations-'));
  await cp(new URL('../migrations/', import.meta.url), directory, { recursive: true });
  const changed = join(directory, '038_execution_live_rpc_budget.sql');
  await writeFile(changed, `${await readFile(changed, 'utf8')}\n-- drift\n`);
  await assert.rejects(
    validateLiveExecutorMigrationFiles(directory),
    startupFailure('MIGRATION_CATALOG_INVALID'),
  );
});

void test('validates role, exact authority, migrations and live bindings without secret input',
  async () => {
    const calls: string[] = [];
    const values: unknown[][] = [];
    const evidence = await validateLiveExecutorStartup(
      databaseFor(calls, {}, values),
      config(),
      { validateFiles: false },
    );

    assert.deepEqual(calls, ['role', 'authority', 'migrations', 'generation', 'bindings', 'work']);
    assert.deepEqual(Object.keys(evidence), [
      'payloadVersion', 'role', 'migrationHead', 'generationId', 'providerId', 'phase',
    ]);
    assert.deepEqual(evidence, {
      payloadVersion: 1,
      role: 'sol_token_executor_live',
      migrationHead: '038_execution_live_rpc_budget.sql',
      generationId: GENERATION_ID,
      providerId: 'primary',
      phase: 'CANARY',
    });
    assert.equal(Object.isFrozen(evidence), true);
    const serializedValues = JSON.stringify(values);
    assert.doesNotMatch(serializedValues, /keypair|secret|database\.example|rpc\.example/iu);
  });

void test('requires PostgreSQL 16 and the exact isolated login-to-group membership', async () => {
  const divergentRoles: readonly Overrides[] = [
    { serverVersionNumber: 150_999 },
    { serverVersionNumber: 170_000 },
    { currentRole: 'sol_token_executor_live_recovery' },
    { sessionRole: 'sol_token_executor_live' },
    { roleLogin: true },
    { roleInherit: true },
    { roleSuper: true },
    { sessionLogin: false },
    { sessionInherit: true },
    { membershipCount: '2' },
    { membershipMember: false },
    { membershipAdmin: true },
    { membershipInherit: true },
    { membershipSet: false },
    { roleParentCount: '1' },
    { sessionDirectAuthorityCount: '1' },
    { searchPath: 'public, pg_catalog' },
    { replicationRole: 'replica' },
    { roleCanSetReplication: true },
    { sessionCanSetReplication: true },
  ];
  for (const overrides of divergentRoles) {
    await assert.rejects(
      validateLiveExecutorStartup(databaseFor([], overrides), config(), {
        validateFiles: false,
      }),
      startupFailure('DATABASE_ROLE_INVALID'),
    );
  }
});

void test('rejects extra, public, grantable, owned and executable authority', async () => {
  const expected = authorityRows();
  const variants = [
    [...expected, authorityRow('COLUMN', 'public.execution_intents', 'mint', 'DELETE')],
    expected.map((row, index) => index === 0 ? { ...row, source: 'PUBLIC' } : row),
    expected.map((row, index) => index === 0 ? { ...row, is_grantable: true } : row),
    [...expected, authorityRow('OWNER', 'public.execution_intents', null, 'OWNER')],
    [...expected, authorityRow(
      'FUNCTION', 'public.execution_guard()', null, 'EXECUTE', false, 'PUBLIC', true,
    )],
  ];
  for (const authority of variants) {
    await assert.rejects(
      validateLiveExecutorStartup(databaseFor([], { authority }), config(), {
        validateFiles: false,
      }),
      startupFailure('DATABASE_AUTHORITY_INVALID'),
    );
  }
});

void test('rejects missing expected authority and malformed authority rows', async () => {
  await assert.rejects(
    validateLiveExecutorStartup(databaseFor([], {
      authority: authorityRows().slice(1),
    }), config(), { validateFiles: false }),
    startupFailure('DATABASE_AUTHORITY_INVALID'),
  );
  await assert.rejects(
    validateLiveExecutorStartup(databaseFor([], {
      authority: [{ ...authorityRows()[0], unexpected: true }],
    }), config(), { validateFiles: false }),
    startupFailure('DATABASE_AUTHORITY_INVALID'),
  );
});

void test('rejects missing, unknown and malformed migration history', async () => {
  for (const migrations of [
    LIVE_EXECUTOR_MIGRATION_CATALOG.slice(0, -1).map((entry) => entry.name),
    [...LIVE_EXECUTOR_MIGRATION_CATALOG.map((entry) => entry.name), '999_unknown.sql'],
    [42],
  ]) {
    await assert.rejects(
      validateLiveExecutorStartup(databaseFor([], { migrations }), config(), {
        validateFiles: false,
      }),
      startupFailure('MIGRATION_CATALOG_INVALID'),
    );
  }
});

void test('rejects retired or divergent wallet, cluster and genesis generations', async () => {
  for (const overrides of [
    { generationWallet: 'Vote111111111111111111111111111111111111111' },
    { generationCluster: 'devnet' },
    { generationGenesis: 'Vote111111111111111111111111111111111111111' },
    { generationRetiredAt: '2026-09-04T00:00:00.000Z' },
  ] as const) {
    await assert.rejects(
      validateLiveExecutorStartup(databaseFor([], overrides), config(), {
        validateFiles: false,
      }),
      startupFailure('GENERATION_BINDING_INVALID'),
    );
  }
});

void test('passes every deployment binding to one fail-closed qualification check', async () => {
  const values: unknown[][] = [];
  await assert.rejects(
    validateLiveExecutorStartup(databaseFor([], { divergentBindings: '1' }, values), config(), {
      validateFiles: false,
    }),
    startupFailure('GENERATION_BINDING_INVALID'),
  );
  assert.deepEqual(values.at(-1), [
    GENERATION_ID, 'CANARY', FINGERPRINT, FINGERPRINT, FINGERPRINT,
    PUBLIC_KEY, 'mainnet-beta', PUBLIC_KEY, 'primary',
  ]);
});

void test('rejects any open transaction, position or exit authorization with divergent identity',
  async () => {
    await assert.rejects(
      validateLiveExecutorStartup(databaseFor([], { divergentWork: '1' }), config(), {
        validateFiles: false,
      }),
      startupFailure('OPEN_WORK_BINDING_INVALID'),
    );
  });

void test('maps query failures to the closed code for their validation boundary', async () => {
  const expected = [
    'DATABASE_ROLE_INVALID',
    'DATABASE_AUTHORITY_INVALID',
    'MIGRATION_CATALOG_INVALID',
    'GENERATION_BINDING_INVALID',
    'GENERATION_BINDING_INVALID',
    'OPEN_WORK_BINDING_INVALID',
  ] as const;
  for (const [failAt, code] of expected.entries()) {
    let queryIndex = 0;
    await assert.rejects(validateLiveExecutorStartup({
      query: async (text, values) => {
        if (queryIndex === failAt) throw new Error('database details must be redacted');
        queryIndex += 1;
        return databaseFor([]).query(text, values);
      },
    }, config(), { validateFiles: false }), startupFailure(code));
  }
});

void test('authority SQL scans all user schemas and exposes grant provenance', () => {
  assert.doesNotMatch(LIVE_EXECUTOR_EFFECTIVE_AUTHORITY_SQL, /nspname\s*=\s*'public'/u);
  assert.match(LIVE_EXECUTOR_EFFECTIVE_AUTHORITY_SQL,
    /NOT IN \('pg_catalog','information_schema','pg_toast'\)/u);
  assert.match(LIVE_EXECUTOR_EFFECTIVE_AUTHORITY_SQL, /pg_temp_%/u);
  assert.match(LIVE_EXECUTOR_EFFECTIVE_AUTHORITY_SQL, /aclexplode/u);
  assert.match(LIVE_EXECUTOR_EFFECTIVE_AUTHORITY_SQL, /PUBLIC/u);
  assert.match(LIVE_EXECUTOR_EFFECTIVE_AUTHORITY_SQL, /OWNER/u);
  assert.match(LIVE_EXECUTOR_EFFECTIVE_AUTHORITY_SQL, /FUNCTION/u);
  assert.match(LIVE_EXECUTOR_EFFECTIVE_AUTHORITY_SQL, /DATABASE/u);
  assert.match(LIVE_EXECUTOR_EFFECTIVE_AUTHORITY_SQL, /TYPE/u);
  assert.match(LIVE_EXECUTOR_EFFECTIVE_AUTHORITY_SQL, /LANGUAGE/u);
  assert.match(LIVE_EXECUTOR_EFFECTIVE_AUTHORITY_SQL, /DEFAULT_ACL/u);
  assert.match(LIVE_EXECUTOR_EFFECTIVE_AUTHORITY_SQL, /pg_database/u);
  assert.match(
    LIVE_EXECUTOR_EFFECTIVE_AUTHORITY_SQL,
    /aclexplode\(\s*COALESCE\(database\.datacl,acldefault\('d',database\.datdba\)\)\s*\)/u,
    'a NULL datacl must expose PostgreSQL default PUBLIC TEMPORARY authority',
  );
  assert.match(
    LIVE_EXECUTOR_EFFECTIVE_AUTHORITY_SQL,
    /acl\.grantee=0[\s\S]*database\.datname=current_database\(\)[\s\S]*TEMPORARY/u,
    'PUBLIC TEMPORARY on the active database must be treated as effective authority',
  );
  assert.match(LIVE_EXECUTOR_EFFECTIVE_AUTHORITY_SQL, /pg_type/u);
  assert.match(LIVE_EXECUTOR_EFFECTIVE_AUTHORITY_SQL, /pg_language/u);
  assert.match(LIVE_EXECUTOR_EFFECTIVE_AUTHORITY_SQL, /pg_default_acl/u);
  assert.equal(
    [...LIVE_EXECUTOR_EFFECTIVE_AUTHORITY_SQL.matchAll(/defaults\.defaclobjtype::TEXT/gu)].length,
    2,
    'PostgreSQL 16 does not implicitly concatenate the internal "char" catalog type',
  );
  assert.match(
    LIVE_EXECUTOR_EFFECTIVE_AUTHORITY_SQL,
    /default_acl_authority[\s\S]*WHERE acl\.grantee IN \(0,\(SELECT oid FROM target\)\)/u,
    'PUBLIC default ACLs can create future effective authority and must be inventoried',
  );
  assert.match(LIVE_EXECUTOR_EFFECTIVE_AUTHORITY_SQL, /is_grantable/u);

  assert.equal(LIVE_EXECUTOR_DATABASE_AUTHORITY_V1.payloadVersion, 1);
  assert.equal(LIVE_EXECUTOR_DATABASE_AUTHORITY_V1.role, 'sol_token_executor_live');
  assert.equal(Object.isFrozen(LIVE_EXECUTOR_DATABASE_AUTHORITY_V1), true);
  assert.equal(Object.isFrozen(LIVE_EXECUTOR_DATABASE_AUTHORITY_V1.tables), true);
  for (const authority of LIVE_EXECUTOR_DATABASE_AUTHORITY_V1.tables) {
    assert.deepEqual(Object.keys(authority), ['name', 'select', 'insert', 'update']);
  }
  assert.deepEqual(LIVE_EXECUTOR_DATABASE_AUTHORITY_V1.functions, []);
  assert.deepEqual(LIVE_EXECUTOR_DATABASE_AUTHORITY_V1.sequences, [{
    name: 'execution_intent_transitions_sequence_seq', privileges: ['USAGE'],
  }]);
});

void test('authority allowlist is restricted to H2b signing and submission primitives', () => {
  const byName = new Map(LIVE_EXECUTOR_DATABASE_AUTHORITY_V1.tables.map((entry) => (
    [entry.name, entry] as const
  )));
  assert.deepEqual([...byName.keys()].sort(), [
    'execution_activation_armaments',
    'execution_activation_events',
    'execution_attempts',
    'execution_control_state',
    'execution_exit_authorizations',
    'execution_exposure_reservations',
    'execution_intent_transitions',
    'execution_intents',
    'execution_live_positions',
    'execution_live_rpc_budgets',
    'execution_live_unsigned_simulation_evidence',
    'execution_pre_submission_revocations',
    'execution_provider_rate_limit_events',
    'execution_provider_usage_counters',
    'execution_provider_usage_snapshots',
    'execution_risk_admission_reports',
    'execution_safety_qualifications',
    'execution_signed_simulation_evidence',
    'execution_signed_transactions',
    'execution_simulation_artifacts',
    'execution_submission_events',
    'execution_submission_preflight_evidence',
    'execution_wallet_generations',
    'execution_wallet_risk_state',
    'market_pools',
    'migration_history',
    'migrations',
  ]);
  for (const forbidden of [
    'execution_reconciliation_evidence', 'execution_fault_ledger',
    'execution_safety_gate_evidence', 'execution_wallet_snapshots',
  ]) assert.equal(byName.has(forbidden), false);

  for (const forbiddenInsert of [
    'execution_intents', 'execution_wallet_risk_state',
    'execution_provider_usage_counters', 'execution_risk_admission_reports',
    'execution_exposure_reservations', 'execution_activation_armaments',
    'execution_live_positions', 'execution_exit_authorizations',
  ]) assert.deepEqual(byName.get(forbiddenInsert)?.insert, []);
  assert.notDeepEqual(byName.get('execution_intent_transitions')?.insert, []);
  assert.deepEqual(byName.get('execution_intent_transitions')?.select, ['intent_id']);
  assert.notDeepEqual(byName.get('execution_activation_events')?.insert, []);
  assert.deepEqual(byName.get('execution_activation_events')?.select, []);
  assert.notDeepEqual(byName.get('execution_simulation_artifacts')?.insert, []);
  assert.deepEqual(
    byName.get('execution_simulation_artifacts')?.select,
    byName.get('execution_simulation_artifacts')?.insert,
    'complete() reads every inserted artifact column through RETURNING *',
  );
  assert.equal(byName.get('execution_signed_transactions')?.update.includes('confirmed_at'), false);
  assert.equal(byName.get('execution_signed_transactions')?.update.includes('confirmed_slot'), false);
  assert.equal(byName.get('execution_signed_transactions')?.update.includes('reconciled_at'), false);
  assert.equal(byName.get('execution_intents')?.update.includes(
    'reconciliation_completed_at'), true,
    'pre-submission evaluator failures and revocations terminally close the intent',
  );
});

interface Overrides {
  readonly serverVersionNumber?: number;
  readonly currentRole?: string;
  readonly sessionRole?: string;
  readonly roleSuper?: boolean;
  readonly roleLogin?: boolean;
  readonly roleInherit?: boolean;
  readonly sessionLogin?: boolean;
  readonly sessionInherit?: boolean;
  readonly membershipCount?: string;
  readonly membershipMember?: boolean;
  readonly membershipAdmin?: boolean;
  readonly membershipInherit?: boolean;
  readonly membershipSet?: boolean;
  readonly roleParentCount?: string;
  readonly sessionDirectAuthorityCount?: string;
  readonly searchPath?: string;
  readonly replicationRole?: string;
  readonly roleCanSetReplication?: boolean;
  readonly sessionCanSetReplication?: boolean;
  readonly authority?: readonly Readonly<Record<string, unknown>>[];
  readonly migrations?: readonly unknown[];
  readonly generationWallet?: string;
  readonly generationCluster?: string;
  readonly generationGenesis?: string;
  readonly generationRetiredAt?: string | null;
  readonly divergentBindings?: string;
  readonly divergentWork?: string;
}

function databaseFor(calls: string[], overrides: Overrides = {}, valuesLog: unknown[][] = []) {
  return {
    async query(text: string, values: readonly unknown[] = []) {
      valuesLog.push([...values]);
      if (text.includes('live_executor_effective_authority')) {
        calls.push('authority');
        const rows = overrides.authority ?? authorityRows();
        return { rows, rowCount: rows.length };
      }
      if (text.includes('server_version_num')) {
        calls.push('role');
        return result({
          server_version_number: overrides.serverVersionNumber ?? 160_000,
          current_role: overrides.currentRole ?? 'sol_token_executor_live',
          session_role: overrides.sessionRole ?? 'sol_token_executor_live_login',
          search_path: overrides.searchPath ?? 'pg_catalog, public',
          session_replication_role: overrides.replicationRole ?? 'origin',
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
          live_membership: overrides.membershipMember ?? true,
          membership_admin: overrides.membershipAdmin ?? false,
          membership_inherit: overrides.membershipInherit ?? false,
          membership_set: overrides.membershipSet ?? true,
          role_parent_count: overrides.roleParentCount ?? '0',
          session_direct_authority_count: overrides.sessionDirectAuthorityCount ?? '0',
          role_can_set_replication: overrides.roleCanSetReplication ?? false,
          session_can_set_replication: overrides.sessionCanSetReplication ?? false,
        });
      }
      if (text.includes('migration_history')) {
        calls.push('migrations');
        const rows = (overrides.migrations
          ?? LIVE_EXECUTOR_MIGRATION_CATALOG.map((entry) => entry.name))
          .map((version) => ({ version }));
        return { rows, rowCount: rows.length };
      }
      if (text.includes('FROM execution_wallet_generations')) {
        calls.push('generation');
        assert.deepEqual(values, [GENERATION_ID]);
        return result({
          generation_id: GENERATION_ID,
          wallet_public_key: overrides.generationWallet ?? PUBLIC_KEY,
          cluster: overrides.generationCluster ?? 'mainnet-beta',
          genesis_hash: overrides.generationGenesis ?? PUBLIC_KEY,
          retired_at: overrides.generationRetiredAt ?? null,
        });
      }
      if (text.includes('divergent_binding_count')) {
        calls.push('bindings');
        return result({ divergent_binding_count: overrides.divergentBindings ?? '0' });
      }
      if (text.includes('divergent_work_count')) {
        calls.push('work');
        assert.deepEqual(values, [GENERATION_ID, PUBLIC_KEY, 'primary', 12]);
        return result({ divergent_work_count: overrides.divergentWork ?? '0' });
      }
      throw new Error('Unexpected query.');
    },
  };
}

function authorityRows(): readonly Readonly<Record<string, unknown>>[] {
  const authority = LIVE_EXECUTOR_DATABASE_AUTHORITY_V1;
  const rows: Readonly<Record<string, unknown>>[] = [
    authorityRow('SCHEMA', authority.schema, null, 'USAGE'),
  ];
  for (const table of authority.tables) {
    for (const [privilege, columns] of [
      ['SELECT', table.select], ['INSERT', table.insert], ['UPDATE', table.update],
    ] as const) for (const column of columns) rows.push(authorityRow(
      'COLUMN', `${authority.schema}.${table.name}`, column, privilege,
    ));
  }
  for (const sequence of authority.sequences) {
    for (const privilege of sequence.privileges) rows.push(authorityRow(
      'SEQUENCE', `${authority.schema}.${sequence.name}`, null, privilege,
    ));
  }
  return rows.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function authorityRow(
  kind: string,
  objectName: string,
  subobjectName: string | null,
  privilege: string,
  isGrantable = false,
  source = 'ROLE',
  securityDefiner = false,
): Readonly<Record<string, unknown>> {
  return {
    kind, object_name: objectName, subobject_name: subobjectName,
    privilege, is_grantable: isGrantable, source, security_definer: securityDefiner,
  };
}

function result(row: Readonly<Record<string, unknown>>) {
  return { rows: [row], rowCount: 1 };
}

function startupFailure(code: LiveExecutorStartupError['code']) {
  return (error: unknown): boolean => error instanceof LiveExecutorStartupError
    && error.code === code
    && !error.message.includes('database details')
    && !error.message.includes('secret');
}

function config(): LiveExecutorConfig {
  return Object.freeze({
    mode: 'live', liveTradingEnabled: true, cluster: 'mainnet-beta',
    databaseUrl: 'postgresql://database.example/secret', pollMs: 1_000, leaseMs: 60_000,
    databaseStatementTimeoutMs: 3_000, shutdownGraceMs: 10_000,
    generationId: GENERATION_ID, executorPublicKey: PUBLIC_KEY,
    keypairPath: '/secret/keypair.json', providerId: 'primary',
    httpRpcUrl: 'https://rpc.example/secret', expectedGenesisHash: PUBLIC_KEY,
    buildHash: FINGERPRINT, configurationFingerprint: FINGERPRINT,
    strategyFingerprint: FINGERPRINT, phase: 'CANARY', quoteMaxAgeMs: 3_000,
    slippageBps: 50n, snapshotMaxSlotLag: 2, maxComputeUnits: 200_000n,
    maxFeeLamports: 5_000n, maxFeePayerLamportDebit: 1_000_000n,
    maxPriorityFeeLamports: 0n, rpcTimeoutMs: 5_000, maxRpcCallsPerAttempt: 12,
    quoteMintAllowlist: Object.freeze([
      'So11111111111111111111111111111111111111112',
    ] as const),
  });
}
