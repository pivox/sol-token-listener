import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  AccountLayout,
  AccountState,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  PublicKey,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  buildPumpFunPlan,
  type PumpFunBuildRequestV1,
} from '../src/executor-simulation/pumpfun-adapter.js';
import {
  ExecutionSimulationGatewayError,
  SolanaSimulationGateway,
} from '../src/executor-simulation/solana-simulation-gateway.js';
import { BuildReceiptAuthority } from '../src/executor-simulation/build-receipt.js';
import {
  bondingCurvePda,
  GLOBAL_PDA,
  PUMP_FEE_CONFIG_PDA,
  PUMP_FEE_PROGRAM_ID,
  PUMP_PROGRAM_ID,
} from '../src/launchpads/pumpfun/official-sdk.js';
import {
  GLOBAL_CONFIG_PDA,
  PUMP_AMM_FEE_CONFIG_PDA,
  PUMP_AMM_PROGRAM_ID,
  PUMP_FEE_PROGRAM_ID as PUMP_SWAP_FEE_PROGRAM_ID,
  poolV2Pda,
  userVolumeAccumulatorPda,
} from '../src/markets/pumpswap/official-sdk.js';
import type { UnsignedBuildPlanV1 } from '../src/executor-simulation/build-plan.js';
import type {
  ExecutionAccountSnapshot,
  ExecutionInnerInstruction,
  ExecutionLatestBlockhash,
  ExecutionMarketGateway,
  ExecutionMessageFee,
  ExecutionProviderUsage,
  ExecutionRpcAccount,
  ExecutionUnsignedSimulationRequest,
  ExecutionUnsignedSimulationResult,
} from '../src/ports/execution-market-gateway.js';
import { loadPumpSwapSellGoldenPlan } from './helpers/executor-simulation-golden.js';

const PAYER = key(10);
const MINT = key(20);
const BASE_ATA = getAssociatedTokenAddressSync(
  new PublicKey(MINT), new PublicKey(PAYER), true, TOKEN_PROGRAM_ID,
).toBase58();
const BASE_ATA_2022 = getAssociatedTokenAddressSync(
  new PublicKey(MINT), new PublicKey(PAYER), true, TOKEN_2022_PROGRAM_ID,
).toBase58();
const QUOTE_ATA = getAssociatedTokenAddressSync(
  NATIVE_MINT, new PublicKey(PAYER), true, TOKEN_PROGRAM_ID,
).toBase58();
const BLOCKHASH = key(210);
const SLOT = 123n;
const PUMP_EVENT_AUTHORITY = PublicKey.findProgramAddressSync(
  [Buffer.from('__event_authority')], PUMP_PROGRAM_ID,
)[0].toBase58();

void test('simulates the strict PumpSwap SELL golden plan against its canonical 14-account snapshot', async () => {
  const fixturePlan = await loadPumpSwapSellGoldenPlan();
  const pre = pumpSwapSnapshot(fixturePlan);
  assert.equal(pre.addresses.length, 14);
  assert.equal(
    pre.addresses[13],
    bondingCurvePda(new PublicKey(fixturePlan.identity.mint)).toBase58(),
  );
  const snapshotFingerprint = fingerprint(pre);
  const plan = pumpSwapPlanWithFingerprint(fixturePlan, snapshotFingerprint);
  const base = expectedAddress(plan, 'USER_BASE_ATA');
  const quote = expectedAddress(plan, 'USER_QUOTE_ATA');
  const provider = new ScriptedGateway(pre, deepFreeze({
    providerId: 'primary', contextSlot: 125n, failureKind: null,
    logs: ['Program log: success'], unitsConsumed: 25_000n,
    accounts: [
      systemAccount(plan.feePayer, 10_000_003n),
      tokenAccount(base, plan.identity.mint, plan.feePayer, 990n, 2_039_280n, false, TOKEN_2022_PROGRAM_ID),
      null,
    ],
    innerInstructions: [],
  } satisfies ExecutionUnsignedSimulationResult));

  const result = await new SolanaSimulationGateway(provider, provider.receiptAuthority, limits()).simulate(
    gatewayInput(provider, plan, pre), activeSignal(),
  );

  assert.equal(result.outcome, 'SUCCESS');
  assert.equal(result.snapshotFingerprint, snapshotFingerprint);
  assert.equal(result.simulatedBaseDeltaRaw, -10n);
  assert.equal(result.simulatedQuoteDeltaRaw, 8n);
  assert.deepEqual(provider.calls, ['blockhash', 'fee', 'simulate']);
  assert.deepEqual(provider.simulationRequest?.accountAddresses, [plan.feePayer, base, quote]);
});

void test('rejects a reordered PumpSwap canonical snapshot before RPC', async () => {
  const fixturePlan = await loadPumpSwapSellGoldenPlan();
  const canonical = pumpSwapSnapshot(fixturePlan);
  const addresses = [...canonical.addresses];
  const accounts = [...canonical.accounts];
  const firstAddress = requiredAt(addresses, 0);
  addresses[0] = requiredAt(addresses, 1);
  addresses[1] = firstAddress;
  const firstAccount = requiredAt(accounts, 0);
  accounts[0] = requiredAt(accounts, 1);
  accounts[1] = firstAccount;
  const reordered = Object.freeze({
    ...canonical, addresses: Object.freeze(addresses), accounts: Object.freeze(accounts),
  });
  const plan = pumpSwapPlanWithFingerprint(fixturePlan, fingerprint(reordered));
  const provider = new ScriptedGateway(reordered, successfulSimulation(reordered));

  await rejectsGateway(
    new SolanaSimulationGateway(provider, provider.receiptAuthority, limits()).simulate(
      gatewayInput(provider, plan, reordered), activeSignal(),
    ),
    'BUILD',
    'SIMULATION_EVIDENCE_INVALID',
  );
  assert.deepEqual(provider.calls, []);
});

void test('requires the canonical Pump.fun bonding curve as a non-executable Pump-owned PumpSwap snapshot account', async () => {
  const fixturePlan = await loadPumpSwapSellGoldenPlan();
  const canonical = pumpSwapSnapshot(fixturePlan);
  const curve = requiredAt(canonical.accounts, 13);
  assert.ok(curve);
  const invalidAccounts = [
    null,
    opaqueAccount(curve.address, PublicKey.default.toBase58()),
    Object.freeze({ ...curve, executable: true }),
  ] as const;

  for (const invalidCurve of invalidAccounts) {
    const accounts = [...canonical.accounts];
    accounts[13] = invalidCurve;
    const snapshot = Object.freeze({ ...canonical, accounts: Object.freeze(accounts) });
    const plan = pumpSwapPlanWithFingerprint(fixturePlan, fingerprint(snapshot));
    const provider = new ScriptedGateway(snapshot, successfulSimulation(snapshot));

    await rejectsGateway(
      new SolanaSimulationGateway(provider, provider.receiptAuthority, limits()).simulate(
        gatewayInput(provider, plan, snapshot), activeSignal(),
      ),
      'BUILD',
      'SIMULATION_EVIDENCE_INVALID',
    );
    assert.deepEqual(provider.calls, []);
  }
});

void test('binds the PumpSwap snapshot fingerprint to the canonical Pump.fun bonding curve account', async () => {
  const fixturePlan = await loadPumpSwapSellGoldenPlan();
  const canonical = pumpSwapSnapshot(fixturePlan);
  const canonicalFingerprint = fingerprint(canonical);
  const accounts = [...canonical.accounts];
  const curve = requiredAt(accounts, 13);
  assert.ok(curve);
  accounts[13] = Object.freeze({ ...curve, lamports: curve.lamports + 1n });
  const changed = Object.freeze({ ...canonical, accounts: Object.freeze(accounts) });
  assert.notEqual(fingerprint(changed), canonicalFingerprint);
  const plan = pumpSwapPlanWithFingerprint(fixturePlan, canonicalFingerprint);
  const provider = new ScriptedGateway(changed, successfulSimulation(changed));

  await rejectsGateway(
    new SolanaSimulationGateway(provider, provider.receiptAuthority, limits()).simulate(
      gatewayInput(provider, plan, changed), activeSignal(),
    ),
    'BUILD',
    'SIMULATION_EVIDENCE_INVALID',
  );
  assert.deepEqual(provider.calls, []);
});

void test('simulates a canonical Pump.fun SELL as an ephemeral unsigned v0 transaction', async () => {
  const pre = pumpFunSnapshot([
    systemAccount(PAYER, 10_000_000n),
    tokenAccount(BASE_ATA, MINT, PAYER, 1_000n, 2_039_280n, false),
    tokenAccount(QUOTE_ATA, NATIVE_MINT.toBase58(), PAYER, 50n, 2_039_330n, true),
  ]);
  const plan = await buildPumpFunPlan(pumpFunRequest('SELL', fingerprint(pre)));
  const provider = new ScriptedGateway(pre, Object.freeze({
    providerId: 'primary', contextSlot: 125n, failureKind: null,
    logs: Object.freeze(['Program log: success']), unitsConsumed: 25_000n,
    accounts: Object.freeze([
      systemAccount(PAYER, 10_000_095n),
      tokenAccount(BASE_ATA, MINT, PAYER, 900n, 2_039_280n, false),
      tokenAccount(QUOTE_ATA, NATIVE_MINT.toBase58(), PAYER, 50n, 2_039_330n, true),
    ]),
    innerInstructions: Object.freeze([]),
  }));
  const gateway = new SolanaSimulationGateway(provider, provider.receiptAuthority, limits());

  const result = await gateway.simulate(gatewayInput(provider, plan, pre), activeSignal());

  assert.equal(result.outcome, 'SUCCESS');
  assert.equal(result.blockhash, BLOCKHASH);
  assert.equal(result.blockhashContextSlot, 124n);
  assert.equal(result.feeContextSlot, 124n);
  assert.equal(result.simulationSlot, 125n);
  assert.equal(result.estimatedFeeLamports, 5n);
  assert.equal(result.unitsConsumed, 25_000n);
  assert.equal(result.simulatedBaseDeltaRaw, -100n);
  assert.equal(result.simulatedQuoteDeltaRaw, 100n);
  assert.equal(result.simulatedFeePayerLamportDebit, 0n);
  assert.equal(result.snapshotFingerprint, fingerprint(pre));
  assert.match(result.buildFingerprint, /^[0-9a-f]{64}$/u);
  assert.match(result.messageHash, /^[0-9a-f]{64}$/u);
  assert.match(result.logsFingerprint, /^[0-9a-f]{64}$/u);
  assert.equal(result.logsLineCount, 1);
  assert.deepEqual(Object.keys(result).sort(), [
    'blockhash', 'blockhashContextSlot', 'buildFingerprint', 'estimatedFeeLamports',
    'feeContextSlot', 'lastValidBlockHeight', 'logsFingerprint', 'logsLineCount',
    'messageHash', 'outcome', 'simulatedBaseDeltaRaw', 'simulatedFeePayerLamportDebit', 'snapshotFingerprint',
    'simulatedQuoteDeltaRaw', 'simulationSlot', 'unitsConsumed',
  ].sort());

  assert.deepEqual(provider.calls, ['blockhash', 'fee', 'simulate']);
  assert.ok(provider.messageBase64 !== null);
  assert.ok(provider.transactionBase64 !== null);
  const transaction = VersionedTransaction.deserialize(
    Buffer.from(provider.transactionBase64, 'base64'),
  );
  assert.equal(transaction.version, 0);
  assert.equal(transaction.message.addressTableLookups.length, 0);
  assert.equal(transaction.message.header.numRequiredSignatures, 1);
  assert.equal(transaction.message.staticAccountKeys[0]?.toBase58(), PAYER);
  assert.equal(transaction.signatures.length, 1);
  assert.equal(transaction.signatures[0]?.length, 64);
  assert.ok(transaction.signatures[0]?.every((byte) => byte === 0));
  assert.equal(
    provider.messageBase64,
    Buffer.from(transaction.message.serialize()).toString('base64'),
  );
  assert.deepEqual(provider.simulationRequest?.accountAddresses, [PAYER, BASE_ATA, QUOTE_ATA]);
});

void test('simulates a Pump.fun BUY when the causal base ATA is absent and then created', async () => {
  const pre = pumpFunSnapshot([
    systemAccount(PAYER, 10_000_000n),
    null,
    tokenAccount(QUOTE_ATA, NATIVE_MINT.toBase58(), PAYER, 50n, 2_039_330n, true),
  ]);
  const plan = await buildPumpFunPlan(pumpFunRequest('BUY', fingerprint(pre)));
  const provider = new ScriptedGateway(pre, Object.freeze({
    providerId: 'primary', contextSlot: 125n, failureKind: null,
    logs: Object.freeze(['Program log: success']), unitsConsumed: 25_000n,
    accounts: Object.freeze([
      systemAccount(PAYER, 7_960_625n),
      tokenAccount(BASE_ATA, MINT, PAYER, 100n, 2_039_280n, false),
      tokenAccount(QUOTE_ATA, NATIVE_MINT.toBase58(), PAYER, 50n, 2_039_330n, true),
    ]),
    innerInstructions: Object.freeze([]),
  }));
  const result = await new SolanaSimulationGateway(provider, provider.receiptAuthority, limits()).simulate(
    gatewayInput(provider, plan, pre), activeSignal(),
  );
  assert.equal(result.simulatedBaseDeltaRaw, 100n);
  assert.equal(result.simulatedQuoteDeltaRaw, -90n);
  assert.deepEqual(provider.calls, ['blockhash', 'fee', 'simulate']);
});

// Agave 4.3 (Helius apiVersion 4.3.0) returns a requested address that does not
// exist as a zero-lamport System-owned account instead of null. The payer WSOL ATA
// of a Pump.fun BUY is such an address; the causal snapshot still has it as null.
void test('treats an Agave 4.3 default-empty quote account as absent on a Token-2022 BUY', async () => {
  const pre = pumpFunSnapshot([systemAccount(PAYER, 10_000_000n), null, null], BASE_ATA_2022);
  const plan = await buildPumpFunPlan(pumpFunRequest('BUY', fingerprint(pre), 'TOKEN_2022'));
  const provider = new ScriptedGateway(pre, Object.freeze({
    providerId: 'primary', contextSlot: 125n, failureKind: null,
    logs: Object.freeze(['Program log: success']), unitsConsumed: 102_482n,
    accounts: Object.freeze([
      systemAccount(PAYER, 8_486_065n),
      tokenAccount(BASE_ATA_2022, MINT, PAYER, 100n, 1_513_840n, false, TOKEN_2022_PROGRAM_ID),
      defaultEmptyAccount(QUOTE_ATA),
    ]),
    innerInstructions: Object.freeze([]),
  }));
  const result = await new SolanaSimulationGateway(provider, provider.receiptAuthority, limits()).simulate(
    gatewayInput(provider, plan, pre), activeSignal(),
  );
  assert.equal(result.outcome, 'SUCCESS');
  assert.equal(result.simulatedBaseDeltaRaw, 100n);
  assert.equal(result.simulatedQuoteDeltaRaw, -90n);
  assert.equal(result.simulatedFeePayerLamportDebit, 1_513_935n);
  assert.equal(result.unitsConsumed, 102_482n);
  assert.deepEqual(provider.simulationRequest?.accountAddresses, [PAYER, BASE_ATA_2022, QUOTE_ATA]);
});

void test('still rejects a non-empty System-owned account returned in a token account position', async () => {
  const pre = pumpFunSnapshot([systemAccount(PAYER, 10_000_000n), null, null]);
  const plan = await buildPumpFunPlan(pumpFunRequest('BUY', fingerprint(pre)));
  const provider = new ScriptedGateway(pre, Object.freeze({
    providerId: 'primary', contextSlot: 125n, failureKind: null,
    logs: Object.freeze(['Program log: success']), unitsConsumed: 25_000n,
    accounts: Object.freeze([
      systemAccount(PAYER, 7_960_625n),
      tokenAccount(BASE_ATA, MINT, PAYER, 100n, 2_039_280n, false),
      Object.freeze({ ...defaultEmptyAccount(QUOTE_ATA), lamports: 1n }),
    ]),
    innerInstructions: Object.freeze([]),
  }));
  await rejectsGateway(
    new SolanaSimulationGateway(provider, provider.receiptAuthority, limits()).simulate(
      gatewayInput(provider, plan, pre), activeSignal(),
    ),
    'SIMULATION',
    'RPC_RESPONSE_INVALID',
  );
});

void test('classifies a program failure whose three post accounts are null as SIMULATION_PROGRAM_ERROR', async () => {
  const pre = pumpFunSnapshot([systemAccount(PAYER, 10_000_000n), null, null]);
  const plan = await buildPumpFunPlan(pumpFunRequest('BUY', fingerprint(pre)));
  const provider = new ScriptedGateway(pre, Object.freeze({
    providerId: 'primary', contextSlot: 125n, failureKind: 'PROGRAM_ERROR' as const,
    logs: Object.freeze(['Program log: Error: TooMuchSolRequired', 'Program failed']), unitsConsumed: 77_094n,
    accounts: Object.freeze([null, null, null]),
    innerInstructions: Object.freeze([]),
  }));
  const error = await rejectsGateway(
    new SolanaSimulationGateway(provider, provider.receiptAuthority, limits()).simulate(
      gatewayInput(provider, plan, pre), activeSignal(),
    ),
    'SIMULATION',
    'SIMULATION_PROGRAM_ERROR',
  );
  assert.equal(error.evidence.simulationSlot, 125n);
  assert.equal(error.evidence.unitsConsumed, 77_094n);
  assert.equal(error.evidence.simulatedFeePayerLamportDebit, null);
  assert.equal(error.evidence.simulatedBaseDeltaRaw, null);
  assert.equal(error.evidence.simulatedQuoteDeltaRaw, null);
  assert.match(error.evidence.logsFingerprint ?? '', /^[0-9a-f]{64}$/u);
  assert.equal(error.evidence.logsLineCount, 2);
  assert.deepEqual(provider.calls, ['blockhash', 'fee', 'simulate']);
});

void test('keeps SELL quote flow stable when a terminal WSOL account is closed', async () => {
  const pre = pumpFunSnapshot([
    systemAccount(PAYER, 10_000_000n),
    tokenAccount(BASE_ATA, MINT, PAYER, 1_000n, 2_039_280n, false),
    tokenAccount(QUOTE_ATA, NATIVE_MINT.toBase58(), PAYER, 50n, 2_039_330n, true),
  ]);
  const plan = await buildPumpFunPlan(pumpFunRequest('SELL', fingerprint(pre)));
  const provider = new ScriptedGateway(pre, Object.freeze({
    providerId: 'primary', contextSlot: 125n, failureKind: null,
    logs: Object.freeze(['Program log: success']), unitsConsumed: 25_000n,
    accounts: Object.freeze([
      systemAccount(PAYER, 12_039_425n),
      tokenAccount(BASE_ATA, MINT, PAYER, 900n, 2_039_280n, false),
      null,
    ]),
    innerInstructions: Object.freeze([]),
  }));
  const result = await new SolanaSimulationGateway(provider, provider.receiptAuthority, limits()).simulate(
    gatewayInput(provider, plan, pre), activeSignal(),
  );
  assert.equal(result.simulatedQuoteDeltaRaw, 100n);
  assert.equal(result.simulatedBaseDeltaRaw, -100n);
});

void test('rejects a snapshot fingerprint mismatch before any post-snapshot RPC', async () => {
  const pre = pumpFunSnapshot([
    systemAccount(PAYER, 10_000_000n),
    tokenAccount(BASE_ATA, MINT, PAYER, 1_000n, 2_039_280n, false),
    tokenAccount(QUOTE_ATA, NATIVE_MINT.toBase58(), PAYER, 50n, 2_039_330n, true),
  ]);
  const plan = await buildPumpFunPlan(pumpFunRequest('SELL', 'a'.repeat(64)));
  const provider = new ScriptedGateway(pre, Object.freeze({
    providerId: 'primary', contextSlot: 125n, failureKind: null,
    logs: Object.freeze(['Program log: success']), unitsConsumed: 25_000n,
    accounts: Object.freeze([
      systemAccount(PAYER, 10_000_095n),
      tokenAccount(BASE_ATA, MINT, PAYER, 900n, 2_039_280n, false),
      tokenAccount(QUOTE_ATA, NATIVE_MINT.toBase58(), PAYER, 50n, 2_039_330n, true),
    ]), innerInstructions: Object.freeze([]),
  }));
  const gateway = new SolanaSimulationGateway(provider, provider.receiptAuthority, limits());

  await rejectsGateway(
    gateway.simulate(gatewayInput(provider, plan, pre), activeSignal()),
    'BUILD',
    'SIMULATION_EVIDENCE_INVALID',
  );
  assert.deepEqual(provider.calls, []);
});

void test('rejects a copied snapshot that was not issued by the pinned provider session', async () => {
  const pre = pumpFunSnapshot([
    systemAccount(PAYER, 10_000_000n),
    tokenAccount(BASE_ATA, MINT, PAYER, 1_000n, 2_039_280n, false),
    tokenAccount(QUOTE_ATA, NATIVE_MINT.toBase58(), PAYER, 50n, 2_039_330n, true),
  ]);
  const copied = Object.freeze({ ...pre });
  const plan = await buildPumpFunPlan(pumpFunRequest('SELL', fingerprint(pre)));
  const provider = new ScriptedGateway(pre, successfulSimulation(pre));
  await rejectsGateway(
    new SolanaSimulationGateway(provider, provider.receiptAuthority, limits()).simulate(gatewayInput(provider, plan, copied), activeSignal()),
    'BUILD',
    'SIMULATION_EVIDENCE_INVALID',
  );
  assert.deepEqual(provider.calls, []);
});

void test('rejects a returned token account whose decoded mint differs from the inspected plan', async () => {
  const pre = pumpFunSnapshot([
    systemAccount(PAYER, 10_000_000n),
    tokenAccount(BASE_ATA, MINT, PAYER, 1_000n, 2_039_280n, false),
    tokenAccount(QUOTE_ATA, NATIVE_MINT.toBase58(), PAYER, 50n, 2_039_330n, true),
  ]);
  const plan = await buildPumpFunPlan(pumpFunRequest('SELL', fingerprint(pre)));
  const provider = new ScriptedGateway(pre, Object.freeze({
    providerId: 'primary', contextSlot: 125n, failureKind: null,
    logs: Object.freeze(['Program log: success']), unitsConsumed: 25_000n,
    accounts: Object.freeze([
      systemAccount(PAYER, 10_000_095n),
      tokenAccount(BASE_ATA, key(240), PAYER, 900n, 2_039_280n, false),
      tokenAccount(QUOTE_ATA, NATIVE_MINT.toBase58(), PAYER, 50n, 2_039_330n, true),
    ]),
    innerInstructions: Object.freeze([]),
  }));

  await rejectsGateway(
    new SolanaSimulationGateway(provider, provider.receiptAuthority, limits()).simulate(gatewayInput(provider, plan, pre), activeSignal()),
    'SIMULATION',
    'RPC_RESPONSE_INVALID',
  );
  assert.deepEqual(provider.calls, ['blockhash', 'fee', 'simulate']);
});

void test('retains only partial hashes on absent or oversized fee and never simulates', async () => {
  for (const feeLamports of [null, 10_001n] as const) {
    const pre = pumpFunSnapshot([
      systemAccount(PAYER, 10_000_000n),
      tokenAccount(BASE_ATA, MINT, PAYER, 1_000n, 2_039_280n, false),
      tokenAccount(QUOTE_ATA, NATIVE_MINT.toBase58(), PAYER, 50n, 2_039_330n, true),
    ]);
    const plan = await buildPumpFunPlan(pumpFunRequest('SELL', fingerprint(pre)));
    const provider = new ScriptedGateway(pre, successfulSimulation(pre), feeLamports);
    const gateway = new SolanaSimulationGateway(provider, provider.receiptAuthority, limits());

    const error = await rejectsGateway(
      gateway.simulate(gatewayInput(provider, plan, pre), activeSignal()),
      'FEE',
      'SIMULATION_EVIDENCE_INVALID',
    );
    assert.match(error.evidence.buildFingerprint ?? '', /^[0-9a-f]{64}$/u);
    assert.match(error.evidence.messageHash ?? '', /^[0-9a-f]{64}$/u);
    assert.equal(error.evidence.blockhash, BLOCKHASH);
    assert.equal(error.evidence.estimatedFeeLamports, null);
    assert.deepEqual(provider.calls, ['blockhash', 'fee']);
    assert.doesNotMatch(JSON.stringify(error.evidence), /Base64|signature|instruction|transaction/iu);
  }
});

void test('maps a simulated program failure with bounded evidence but no raw logs or transaction bytes', async () => {
  const pre = pumpFunSnapshot([
    systemAccount(PAYER, 10_000_000n),
    tokenAccount(BASE_ATA, MINT, PAYER, 1_000n, 2_039_280n, false),
    tokenAccount(QUOTE_ATA, NATIVE_MINT.toBase58(), PAYER, 50n, 2_039_330n, true),
  ]);
  const plan = await buildPumpFunPlan(pumpFunRequest('SELL', fingerprint(pre)));
  const provider = new ScriptedGateway(pre, Object.freeze({
    providerId: 'primary', contextSlot: 125n, failureKind: 'PROGRAM_ERROR' as const,
    logs: Object.freeze(['private program log']), unitsConsumed: 25_000n,
    accounts: Object.freeze([
      systemAccount(PAYER, 9_995_000n),
      tokenAccount(BASE_ATA, MINT, PAYER, 0n, 2_039_280n, false),
      tokenAccount(QUOTE_ATA, NATIVE_MINT.toBase58(), PAYER, 50n, 2_039_330n, true),
    ]),
    innerInstructions: Object.freeze([]),
  }), 5_000n);
  const error = await rejectsGateway(
    new SolanaSimulationGateway(provider, provider.receiptAuthority, limits()).simulate(gatewayInput(provider, plan, pre), activeSignal()),
    'SIMULATION',
    'SIMULATION_PROGRAM_ERROR',
  );
  assert.equal(error.evidence.simulationSlot, 125n);
  assert.equal(error.evidence.unitsConsumed, 25_000n);
  assert.equal(error.evidence.simulatedFeePayerLamportDebit, 5_000n);
  assert.equal(error.evidence.simulatedBaseDeltaRaw, -1_000n);
  assert.equal(error.evidence.simulatedQuoteDeltaRaw, 0n);
  assert.match(error.evidence.logsFingerprint ?? '', /^[0-9a-f]{64}$/u);
  assert.equal(error.evidence.logsLineCount, 1);
  assert.doesNotMatch(JSON.stringify(error.evidence), /private|transaction|instruction/iu);
});

void test('validates the complete simulation envelope before classifying a program failure', async () => {
  const pre = pumpFunSnapshot([
    systemAccount(PAYER, 10_000_000n),
    tokenAccount(BASE_ATA, MINT, PAYER, 1_000n, 2_039_280n, false),
    tokenAccount(QUOTE_ATA, NATIVE_MINT.toBase58(), PAYER, 50n, 2_039_330n, true),
  ]);
  const plan = await buildPumpFunPlan(pumpFunRequest('SELL', fingerprint(pre)));
  const provider = new ScriptedGateway(pre, Object.freeze({
    providerId: 'foreign', contextSlot: 125n, failureKind: 'PROGRAM_ERROR' as const,
    logs: Object.freeze([]), unitsConsumed: null, accounts: null, innerInstructions: Object.freeze([]),
  }));
  await rejectsGateway(
    new SolanaSimulationGateway(provider, provider.receiptAuthority, limits()).simulate(gatewayInput(provider, plan, pre), activeSignal()),
    'SIMULATION',
    'RPC_RESPONSE_INVALID',
  );
});

// Agave 4.3 (Helius apiVersion 4.3.0) returns the CPIs of programs it knows
// (System, SPL Token, Token-2022) in jsonParsed form, which the provider session
// maps to PARSED entries without accounts or data. Mirrors a captured Token-2022
// BUY: group 0 = ATA creation (4 parsed CPIs), group 1 = BuyV2 (fee program CPI,
// parsed TransferChecked, 4 parsed System transfers, pump self-CPI).
void test('accepts the parsed inner CPIs of allowed static programs on a Token-2022 BUY', async () => {
  const pre = pumpFunSnapshot([systemAccount(PAYER, 10_000_000n), null, null], BASE_ATA_2022);
  const plan = await buildPumpFunPlan(pumpFunRequest('BUY', fingerprint(pre), 'TOKEN_2022'));
  const system = PublicKey.default.toBase58();
  const token2022 = TOKEN_2022_PROGRAM_ID.toBase58();
  const provider = new ScriptedGateway(pre, deepFreeze({
    providerId: 'primary', contextSlot: 125n, failureKind: null,
    logs: ['Program log: success'], unitsConsumed: 102_482n,
    accounts: [
      systemAccount(PAYER, 8_486_065n),
      tokenAccount(BASE_ATA_2022, MINT, PAYER, 100n, 1_513_840n, false, TOKEN_2022_PROGRAM_ID),
      defaultEmptyAccount(QUOTE_ATA),
    ],
    innerInstructions: [
      {
        index: 0,
        instructions: [
          parsedInner(token2022), parsedInner(system), parsedInner(token2022), parsedInner(token2022),
        ],
      },
      {
        index: 1,
        instructions: [
          {
            kind: 'PARTIALLY_DECODED', programId: PUMP_FEE_PROGRAM_ID.toBase58(),
            accounts: [PUMP_FEE_CONFIG_PDA.toBase58(), PUMP_PROGRAM_ID.toBase58()],
            data: 'KX69VKtJ7u4EBBUge6ccdz6MFdzZSGr9LuKYsmdyg4vxaZ17yLHFCbpu48h28vRbgp74p6smHpha6B',
            stackHeight: 2,
          },
          parsedInner(token2022),
          parsedInner(system), parsedInner(system), parsedInner(system), parsedInner(system),
          {
            kind: 'PARTIALLY_DECODED', programId: PUMP_PROGRAM_ID.toBase58(),
            accounts: [PUMP_EVENT_AUTHORITY], data: 'BUV4LqTLWqEhXptXmSCkvVEiVZTGhZ5DEKXrvZTbS2di8Dfrrork',
            stackHeight: 2,
          },
        ],
      },
    ],
  } satisfies ExecutionUnsignedSimulationResult));

  const result = await new SolanaSimulationGateway(provider, provider.receiptAuthority, limits()).simulate(
    gatewayInput(provider, plan, pre), activeSignal(),
  );

  assert.equal(result.outcome, 'SUCCESS');
  assert.equal(result.simulatedBaseDeltaRaw, 100n);
  assert.deepEqual(provider.calls, ['blockhash', 'fee', 'simulate']);
});

void test('rejects a parsed inner instruction of a program outside the allowlist', async () => {
  await rejectsSellWithInnerInstruction(parsedInner(key(40)));
});

void test('rejects a parsed inner instruction of an allowlisted program absent from the compiled message', async () => {
  await rejectsSellWithInnerInstruction(parsedInner(TOKEN_2022_PROGRAM_ID.toBase58()));
});

void test('rejects a parsed inner instruction that still carries accounts or data', async () => {
  await rejectsSellWithInnerInstruction({
    kind: 'PARSED', programId: TOKEN_PROGRAM_ID.toBase58(), accounts: [], data: null, stackHeight: 2,
  });
  await rejectsSellWithInnerInstruction({
    kind: 'PARSED', programId: TOKEN_PROGRAM_ID.toBase58(), accounts: null, data: '1', stackHeight: 2,
  });
});

void test('rejects a parsed inner instruction whose stack height is out of bounds', async () => {
  await rejectsSellWithInnerInstruction({ ...parsedInner(TOKEN_PROGRAM_ID.toBase58()), stackHeight: 17 });
});

void test('rejects an inner instruction of an unknown kind', async () => {
  await rejectsSellWithInnerInstruction({
    ...parsedInner(TOKEN_PROGRAM_ID.toBase58()), kind: 'COMPILED' as 'PARSED',
  });
});

void test('rejects a partially decoded inner instruction touching a non-static account', async () => {
  await rejectsSellWithInnerInstruction({
    kind: 'PARTIALLY_DECODED', programId: PUMP_PROGRAM_ID.toBase58(),
    accounts: [key(99)], data: '1', stackHeight: 2,
  });
});

void test('rejects an allowlisted inner program absent from the compiled message', async () => {
  const pre = pumpFunSnapshot([
    systemAccount(PAYER, 10_000_000n),
    tokenAccount(BASE_ATA, MINT, PAYER, 1_000n, 2_039_280n, false),
    tokenAccount(QUOTE_ATA, NATIVE_MINT.toBase58(), PAYER, 50n, 2_039_330n, true),
  ]);
  const plan = await buildPumpFunPlan(pumpFunRequest('SELL', fingerprint(pre)));
  const provider = new ScriptedGateway(pre, deepFreeze({
    providerId: 'primary', contextSlot: 125n, failureKind: null,
    logs: ['Program log: success'], unitsConsumed: 25_000n,
    accounts: [
      systemAccount(PAYER, 10_000_095n),
      tokenAccount(BASE_ATA, MINT, PAYER, 900n, 2_039_280n, false),
      tokenAccount(QUOTE_ATA, NATIVE_MINT.toBase58(), PAYER, 50n, 2_039_330n, true),
    ],
    innerInstructions: [{
      index: 0,
      instructions: [{
        kind: 'PARTIALLY_DECODED', programId: PUMP_AMM_PROGRAM_ID.toBase58(),
        accounts: [BASE_ATA], data: '1', stackHeight: 2,
      }],
    }],
  } satisfies ExecutionUnsignedSimulationResult));

  await rejectsGateway(
    new SolanaSimulationGateway(provider, provider.receiptAuthority, limits()).simulate(
      gatewayInput(provider, plan, pre), activeSignal(),
    ),
    'SIMULATION',
    'RPC_RESPONSE_INVALID',
  );
});

void test('distinguishes an already-aborted caller signal before inspection or RPC', async () => {
  const controller = new AbortController();
  controller.abort();
  const provider = new ScriptedGateway(pumpFunSnapshot([
    systemAccount(PAYER, 1n),
    tokenAccount(BASE_ATA, MINT, PAYER, 1n, 2_039_280n, false),
    tokenAccount(QUOTE_ATA, NATIVE_MINT.toBase58(), PAYER, 1n, 2_039_281n, true),
  ]), successfulSimulation(pumpFunSnapshot([
    systemAccount(PAYER, 1n),
    tokenAccount(BASE_ATA, MINT, PAYER, 1n, 2_039_280n, false),
    tokenAccount(QUOTE_ATA, NATIVE_MINT.toBase58(), PAYER, 1n, 2_039_281n, true),
  ])));
  await rejectsGateway(
    new SolanaSimulationGateway(provider, provider.receiptAuthority, limits()).simulate(Object.freeze({} as never), controller.signal),
    'BUILD',
    'OPERATION_ABORTED',
  );
  assert.deepEqual(provider.calls, []);
});

void test('requires a one-shot authority-scoped receipt before any RPC', async () => {
  const pre = pumpFunSnapshot([
    systemAccount(PAYER, 10_000_000n),
    tokenAccount(BASE_ATA, MINT, PAYER, 1_000n, 2_039_280n, false),
    tokenAccount(QUOTE_ATA, NATIVE_MINT.toBase58(), PAYER, 50n, 2_039_330n, true),
  ]);
  const plan = await buildPumpFunPlan(pumpFunRequest('SELL', fingerprint(pre)));
  const provider = new ScriptedGateway(pre, Object.freeze({
    providerId: 'primary', contextSlot: 125n, failureKind: null,
    logs: Object.freeze(['Program log: success']), unitsConsumed: 25_000n,
    accounts: Object.freeze([
      systemAccount(PAYER, 10_000_095n),
      tokenAccount(BASE_ATA, MINT, PAYER, 900n, 2_039_280n, false),
      tokenAccount(QUOTE_ATA, NATIVE_MINT.toBase58(), PAYER, 50n, 2_039_330n, true),
    ]), innerInstructions: Object.freeze([]),
  }));
  const authority = new BuildReceiptAuthority();
  const otherAuthority = new BuildReceiptAuthority();
  const gateway = new SolanaSimulationGateway(provider, authority, limits());
  const receipt = authority.issue(plan, pre);
  const cases = [
    Object.freeze({ plan, snapshot: pre }),
    Object.freeze({ plan, snapshot: pre, receipt: Object.freeze({}) }),
    Object.freeze({ plan, snapshot: pre, receipt: otherAuthority.issue(plan, pre) }),
    Object.freeze({ plan: Object.freeze({ ...plan }), snapshot: pre, receipt: authority.issue(plan, pre) }),
    Object.freeze({ plan, snapshot: Object.freeze({ ...pre }), receipt: authority.issue(plan, pre) }),
  ];
  for (const candidate of cases) {
    await rejectsGateway(gateway.simulate(candidate as never, activeSignal()), 'BUILD', 'SIMULATION_EVIDENCE_INVALID');
  }
  const success = Object.freeze({ plan, snapshot: pre, receipt });
  await gateway.simulate(success, activeSignal());
  await rejectsGateway(gateway.simulate(success, activeSignal()), 'BUILD', 'SIMULATION_EVIDENCE_INVALID');
  assert.deepEqual(provider.calls, ['blockhash', 'fee', 'simulate']);
});

function pumpFunRequest(
  side: 'BUY' | 'SELL',
  snapshotFingerprint: string,
  baseTokenProgram: 'SPL_TOKEN' | 'TOKEN_2022' = 'SPL_TOKEN',
): PumpFunBuildRequestV1 {
  const baseAta = baseTokenProgram === 'SPL_TOKEN' ? BASE_ATA : BASE_ATA_2022;
  return Object.freeze({
    quote: Object.freeze({
      payloadVersion: 1, venue: 'PUMP_FUN', side, mint: MINT,
      quoteMint: NATIVE_MINT.toBase58(), baseTokenProgram,
      quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9,
      amountInRaw: 100n, expectedAmountOutRaw: 100n, protectedAmountOutRaw: 90n,
      snapshotSlot: SLOT, quoteFingerprint: '0'.repeat(64), snapshotFingerprint,
    }),
    user: PAYER,
    curve: Object.freeze({
      mint: MINT, address: bondingCurvePda(new PublicKey(MINT)).toBase58(),
      ownerProgramId: PUMP_PROGRAM_ID.toBase58(), exists: true, complete: false,
      creator: key(30), isMayhemMode: false,
    }),
    userBaseTokenAccount: Object.freeze({ address: baseAta, exists: side === 'SELL' }),
    recipients: Object.freeze({
      feeRecipient: key(100), feeRecipients: frozenKeys(101, 7),
      reservedFeeRecipient: key(110), reservedFeeRecipients: frozenKeys(111, 7),
      buybackFeeRecipients: frozenKeys(120, 8),
    }),
  });
}

function pumpFunSnapshot(
  balanceAccounts: readonly [ExecutionRpcAccount, ExecutionRpcAccount | null, ExecutionRpcAccount | null],
  baseAta: string = BASE_ATA,
): ExecutionAccountSnapshot {
  const curve = bondingCurvePda(new PublicKey(MINT)).toBase58();
  const addresses = Object.freeze([
    GLOBAL_PDA.toBase58(), PUMP_FEE_CONFIG_PDA.toBase58(), MINT, curve,
    PAYER, baseAta, QUOTE_ATA,
  ]);
  const accounts = Object.freeze([
    opaqueAccount(GLOBAL_PDA.toBase58(), PUMP_PROGRAM_ID.toBase58()),
    opaqueAccount(PUMP_FEE_CONFIG_PDA.toBase58(), PUMP_FEE_PROGRAM_ID.toBase58()),
    opaqueAccount(MINT, TOKEN_PROGRAM_ID.toBase58()),
    opaqueAccount(curve, PUMP_PROGRAM_ID.toBase58()),
    ...balanceAccounts,
  ]);
  return Object.freeze({ providerId: 'primary', slot: SLOT, addresses, accounts });
}

function pumpSwapSnapshot(plan: UnsignedBuildPlanV1): ExecutionAccountSnapshot {
  assert.equal(plan.venue, 'PUMP_SWAP');
  assert.equal(plan.policyEvidence.venue, 'PUMP_SWAP');
  const pool = expectedAddress(plan, 'POOL');
  const poolBase = expectedAddress(plan, 'POOL_BASE_VAULT');
  const poolQuote = expectedAddress(plan, 'POOL_QUOTE_VAULT');
  const base = expectedAddress(plan, 'USER_BASE_ATA');
  const quote = expectedAddress(plan, 'USER_QUOTE_ATA');
  const volume = userVolumeAccumulatorPda(new PublicKey(plan.feePayer)).toBase58();
  const volumeQuote = getAssociatedTokenAddressSync(
    NATIVE_MINT, new PublicKey(volume), true, TOKEN_PROGRAM_ID,
  ).toBase58();
  const poolV2 = poolV2Pda(new PublicKey(plan.identity.mint)).toBase58();
  const curve = bondingCurvePda(new PublicKey(plan.identity.mint)).toBase58();
  assert.equal(expectedAddress(plan, 'USER_VOLUME_ACCUMULATOR'), volume);
  assert.equal(expectedAddress(plan, 'USER_VOLUME_QUOTE_ATA'), volumeQuote);
  assert.equal(expectedAddress(plan, 'POOL_V2'), poolV2);
  const addresses = Object.freeze([
    GLOBAL_CONFIG_PDA.toBase58(), PUMP_AMM_FEE_CONFIG_PDA.toBase58(), pool,
    plan.identity.mint, NATIVE_MINT.toBase58(), poolBase, poolQuote, plan.feePayer,
    base, quote, volume, volumeQuote, poolV2, curve,
  ]);
  const accounts = Object.freeze([
    opaqueAccount(requiredAt(addresses, 0), PUMP_AMM_PROGRAM_ID.toBase58()),
    opaqueAccount(requiredAt(addresses, 1), PUMP_SWAP_FEE_PROGRAM_ID.toBase58()),
    opaqueAccount(pool, PUMP_AMM_PROGRAM_ID.toBase58()),
    opaqueAccount(plan.identity.mint, TOKEN_2022_PROGRAM_ID.toBase58()),
    opaqueAccount(NATIVE_MINT.toBase58(), TOKEN_PROGRAM_ID.toBase58()),
    opaqueAccount(poolBase, TOKEN_2022_PROGRAM_ID.toBase58()),
    opaqueAccount(poolQuote, TOKEN_PROGRAM_ID.toBase58()),
    systemAccount(plan.feePayer, 10_000_000n),
    tokenAccount(base, plan.identity.mint, plan.feePayer, 1_000n, 2_039_280n, false, TOKEN_2022_PROGRAM_ID),
    null,
    opaqueAccount(volume, PUMP_AMM_PROGRAM_ID.toBase58()),
    opaqueAccount(volumeQuote, TOKEN_PROGRAM_ID.toBase58()),
    opaqueAccount(poolV2, PUMP_AMM_PROGRAM_ID.toBase58()),
    opaqueAccount(curve, PUMP_PROGRAM_ID.toBase58()),
  ]);
  return Object.freeze({ providerId: 'primary', slot: plan.identity.snapshotSlot, addresses, accounts });
}

function expectedAddress(plan: UnsignedBuildPlanV1, role: string): string {
  const address = plan.expectedAccounts.find((candidate) => candidate.role === role)?.address;
  assert.ok(address);
  return address;
}

function requiredAt<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error('Missing test value.');
  return value;
}

function pumpSwapPlanWithFingerprint(
  plan: UnsignedBuildPlanV1,
  snapshotFingerprint: string,
): UnsignedBuildPlanV1 {
  assert.equal(plan.venue, 'PUMP_SWAP');
  assert.equal(plan.policyEvidence.venue, 'PUMP_SWAP');
  assert.equal(plan.identity.snapshotFingerprint, 'b'.repeat(64));
  assert.equal(plan.policyEvidence.snapshotFingerprint, 'b'.repeat(64));
  return deepFreeze({
    ...plan,
    identity: { ...plan.identity, snapshotFingerprint },
    policyEvidence: { ...plan.policyEvidence, snapshotFingerprint },
  });
}

function opaqueAccount(address: string, owner: string): ExecutionRpcAccount {
  return Object.freeze({
    address, lamports: 1n, owner, executable: false, rentEpoch: null,
    space: 1n, dataBase64: 'AQ==',
  });
}

function systemAccount(address: string, lamports: bigint): ExecutionRpcAccount {
  return Object.freeze({
    address, lamports, owner: PublicKey.default.toBase58(), executable: false,
    rentEpoch: null, space: 0n, dataBase64: '',
  });
}

/** The shape Agave 4.3 returns for a requested address that does not exist. */
function defaultEmptyAccount(address: string): ExecutionRpcAccount {
  return systemAccount(address, 0n);
}

function tokenAccount(
  address: string,
  mint: string,
  owner: string,
  amountRaw: bigint,
  lamports: bigint,
  isNative: boolean,
  programId: PublicKey = TOKEN_PROGRAM_ID,
): ExecutionRpcAccount {
  const base = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({
    mint: new PublicKey(mint), owner: new PublicKey(owner), amount: amountRaw,
    delegateOption: 0, delegate: PublicKey.default, state: AccountState.Initialized,
    isNativeOption: isNative ? 1 : 0, isNative: isNative ? 2_039_280n : 0n,
    delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default,
  }, base);
  // A Token-2022 ATA carries the account-type byte and an ImmutableOwner
  // extension header after the 165-byte legacy layout (170 bytes on mainnet).
  const data = programId.equals(TOKEN_2022_PROGRAM_ID)
    ? Buffer.concat([base, Buffer.from([2, 7, 0, 0, 0])]) : base;
  return Object.freeze({
    address, lamports, owner: programId.toBase58(), executable: false,
    rentEpoch: null, space: BigInt(data.length), dataBase64: data.toString('base64'),
  });
}

function fingerprint(value: ExecutionAccountSnapshot): string {
  const segments = ['execution-snapshot-v1', value.slot.toString(10)];
  for (let index = 0; index < value.addresses.length; index += 1) {
    const address = value.addresses[index];
    const account = value.accounts[index];
    if (address === undefined) throw new Error('Missing address.');
    if (account === null || account === undefined) segments.push(address, 'ABSENT');
    else segments.push(
      address, 'PRESENT', account.owner, account.lamports.toString(10),
      createHash('sha256').update(Buffer.from(account.dataBase64, 'base64')).digest('hex'),
    );
  }
  return createHash('sha256').update(lengthPrefixedUtf8(segments)).digest('hex');
}

function lengthPrefixedUtf8(values: readonly string[]): Buffer {
  return Buffer.concat(values.flatMap((value) => {
    const bytes = Buffer.from(value, 'utf8');
    const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
    return [length, bytes];
  }));
}

function parsedInner(programId: string): ExecutionInnerInstruction {
  return Object.freeze({ kind: 'PARSED', programId, accounts: null, data: null, stackHeight: 2 });
}

async function rejectsSellWithInnerInstruction(instruction: ExecutionInnerInstruction): Promise<void> {
  const pre = pumpFunSnapshot([
    systemAccount(PAYER, 10_000_000n),
    tokenAccount(BASE_ATA, MINT, PAYER, 1_000n, 2_039_280n, false),
    tokenAccount(QUOTE_ATA, NATIVE_MINT.toBase58(), PAYER, 50n, 2_039_330n, true),
  ]);
  const plan = await buildPumpFunPlan(pumpFunRequest('SELL', fingerprint(pre)));
  const provider = new ScriptedGateway(pre, deepFreeze({
    providerId: 'primary', contextSlot: 125n, failureKind: null,
    logs: ['Program log: success'], unitsConsumed: 25_000n,
    accounts: [
      systemAccount(PAYER, 10_000_095n),
      tokenAccount(BASE_ATA, MINT, PAYER, 900n, 2_039_280n, false),
      tokenAccount(QUOTE_ATA, NATIVE_MINT.toBase58(), PAYER, 50n, 2_039_330n, true),
    ],
    innerInstructions: [{ index: 0, instructions: [instruction] }],
  } satisfies ExecutionUnsignedSimulationResult));
  await rejectsGateway(
    new SolanaSimulationGateway(provider, provider.receiptAuthority, limits()).simulate(
      gatewayInput(provider, plan, pre), activeSignal(),
    ),
    'SIMULATION',
    'RPC_RESPONSE_INVALID',
  );
  assert.deepEqual(provider.calls, ['blockhash', 'fee', 'simulate']);
}

function successfulSimulation(snapshotValue: ExecutionAccountSnapshot): ExecutionUnsignedSimulationResult {
  return Object.freeze({
    providerId: 'primary', contextSlot: 125n, failureKind: null,
    logs: Object.freeze(['Program log: success']), unitsConsumed: 25_000n,
    accounts: Object.freeze(snapshotValue.accounts.slice(-3)), innerInstructions: Object.freeze([]),
  });
}

class ScriptedGateway implements ExecutionMarketGateway {
  public readonly providerId = 'primary';
  public readonly receiptAuthority = new BuildReceiptAuthority();
  public readonly calls: string[] = [];
  public messageBase64: string | null = null;
  public transactionBase64: string | null = null;
  public simulationRequest: ExecutionUnsignedSimulationRequest | null = null;

  public constructor(
    private readonly snapshotValue: ExecutionAccountSnapshot,
    private readonly simulationValue: ExecutionUnsignedSimulationResult,
    private readonly feeLamports: bigint | null = 5n,
  ) {}

  public ownsAccountSnapshot(snapshot: ExecutionAccountSnapshot): boolean { return snapshot === this.snapshotValue; }
  public async verifyGenesis(): Promise<never> { throw new Error('not used'); }
  public async readAccountSnapshot(): Promise<ExecutionAccountSnapshot> { return this.snapshotValue; }
  public async getLatestBlockhash(snapshotSlot: bigint): Promise<ExecutionLatestBlockhash> {
    assert.equal(snapshotSlot, this.snapshotValue.slot); this.calls.push('blockhash');
    return Object.freeze({
      providerId: this.providerId, contextSlot: snapshotSlot + 1n, blockhash: BLOCKHASH,
      lastValidBlockHeight: 500n,
    });
  }
  public async getFeeForMessage(messageBase64: string, snapshotSlot: bigint): Promise<ExecutionMessageFee> {
    assert.equal(snapshotSlot, this.snapshotValue.slot); this.calls.push('fee'); this.messageBase64 = messageBase64;
    return Object.freeze({ providerId: this.providerId, contextSlot: snapshotSlot + 1n, feeLamports: this.feeLamports });
  }
  public async simulateUnsignedTransaction(request: ExecutionUnsignedSimulationRequest): Promise<ExecutionUnsignedSimulationResult> {
    this.calls.push('simulate'); this.simulationRequest = request;
    this.transactionBase64 = request.transactionBase64;
    return this.simulationValue;
  }
  public usage(): ExecutionProviderUsage {
    return Object.freeze({ providerId: this.providerId, rpcCallsUsed: this.calls.length, rpcCallsLimit: 8 });
  }
}

function gatewayInput(
  provider: ScriptedGateway,
  plan: Parameters<BuildReceiptAuthority['issue']>[0],
  snapshot: ExecutionAccountSnapshot,
) {
  return Object.freeze({ plan, snapshot, receipt: provider.receiptAuthority.issue(plan, snapshot) });
}

function limits() {
  return Object.freeze({
    maxTransactionBytes: 1_232, maxComputeUnits: 300_000n,
    maxFeeLamports: 10_000n, maxFeePayerLamportDebit: 2_500_000n,
  });
}

async function rejectsGateway(
  promise: Promise<unknown>,
  stage: string,
  code: string,
): Promise<ExecutionSimulationGatewayError> {
  try { await promise; } catch (error) {
    assert.ok(error instanceof ExecutionSimulationGatewayError);
    assert.equal(error.stage, stage); assert.equal(error.code, code);
    return error;
  }
  throw new Error('Expected gateway rejection.');
}

function activeSignal(): AbortSignal { return new AbortController().signal; }

function key(seed: number): string {
  return new PublicKey(Uint8Array.from({ length: 32 }, (_, index) => (seed + index) % 256)).toBase58();
}

function frozenKeys(seed: number, length: number): readonly string[] {
  return Object.freeze(Array.from({ length }, (_, index) => key(seed + index)));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
