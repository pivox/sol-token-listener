import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import {
  createSignedTransactionArtifact,
} from '../src/domain/execution-live.js';
import {
  createExecutionIntentDraft,
  type ExecutionIntentV1,
} from '../src/domain/execution-intent.js';
import { compileInspectedV0Message } from '../src/executor-simulation/message-compiler.js';
import type { UnsignedBuildPlanV1 } from '../src/executor-simulation/build-plan.js';
import type { ExecutionSimulationEvidenceV1 } from
  '../src/ports/execution-simulation-gateway.js';
import {
  createSignedSimulationRecoveryContext,
  SignedSimulationContextError,
} from '../src/executor-live/signed-simulation-context.js';
import {
  resumeLivePersistedTransaction,
  type LiveExecutionWorkerDependencies,
} from '../src/executor-live/execution-worker.js';
import type { ExecutionLiveSignedTransactionInspectionV1 } from
  '../src/ports/execution-live-repository.js';
import type { ClaimedExecutionIntent } from '../src/ports/execution-intent-repository.js';
import { PUMP_PROGRAM_ID } from '../src/launchpads/pumpfun/official-sdk.js';
import { userVolumeAccumulatorPda as pumpSwapUserVolumeAccumulatorPda } from
  '../src/markets/pumpswap/official-sdk.js';

void test('recovers the exact Pump.fun BUY signed-simulation context', async () => {
  const fixture = await signedFixture('pumpfun-buy-v2-plan.json');

  const context = createSignedSimulationRecoveryContext(fixture.input);

  assert.deepEqual(context, Object.freeze({
    payloadVersion: 1,
    snapshotSlot: fixture.unsignedSimulation.blockhashContextSlot,
    accountAddresses: Object.freeze([
      fixture.artifact.walletPublicKey,
      fixture.baseAta,
      fixture.quoteAta,
    ]),
    amountInRaw: fixture.plan.amounts.amountInRaw,
    protectedAmountOutRaw: fixture.plan.amounts.protectedAmountOutRaw,
    unsignedSimulation: fixture.unsignedSimulation,
  }));
});

void test('recovers Token-2022 base and SPL WSOL quote ATAs from PumpSwap SELL', async () => {
  const fixture = await signedFixture('pumpswap-sell-plan.json');

  const context = createSignedSimulationRecoveryContext(fixture.input);

  assert.equal(fixture.plan.identity.baseTokenProgram, 'TOKEN_2022');
  assert.deepEqual(context.accountAddresses, [
    fixture.artifact.walletPublicKey,
    fixture.baseAta,
    fixture.quoteAta,
  ]);
  assert.equal(context.amountInRaw, fixture.plan.amounts.amountInRaw);
  assert.equal(context.protectedAmountOutRaw, fixture.plan.amounts.protectedAmountOutRaw);
});

void test('accepts every exact builder envelope and its permitted optional setup instructions',
  async () => {
    for (const [file, omittedInstructionIndexes] of [
      ['pumpfun-buy-v2-plan.json', []],
      ['pumpfun-buy-v2-plan.json', [0]],
      ['pumpfun-sell-v2-plan.json', []],
      ['pumpswap-sell-plan.json', []],
      ['pumpswap-sell-plan.json', [0]],
      ['pumpswap-sell-plan.json', [1]],
      ['pumpswap-sell-plan.json', [0, 1]],
    ] as const) {
      const fixture = await signedFixture(file, { omittedInstructionIndexes });

      const context = createSignedSimulationRecoveryContext(fixture.input);

      assert.equal(context.snapshotSlot, fixture.unsignedSimulation.blockhashContextSlot);
    }
  });

void test('rejects extra, unknown and out-of-order instructions with one stable error', async () => {
  const cases = [
    await signedFixture('pumpfun-buy-v2-plan.json', { reverseInstructions: true }),
    await signedFixture('pumpfun-sell-v2-plan.json', { appendUnknownInstruction: true }),
    await signedFixture('pumpswap-sell-plan.json', { swapFirstTwoInstructions: true }),
    await signedFixture('pumpswap-sell-plan.json', { duplicateInstructionIndex: 3 }),
  ];

  for (const fixture of cases) {
    assert.throws(
      () => createSignedSimulationRecoveryContext(fixture.input),
      (error: unknown) => isContextError(error)
        && error.name === 'SignedSimulationContextError'
        && error.message === 'Signed simulation recovery context is invalid.',
    );
  }
});

void test('rejects every mutated Pump.fun economic account class', async () => {
  const cases = [
    ['global', 0],
    ['associated token program', 5],
    ['fee recipient', 6],
    ['fee recipient ATA', 7],
    ['buyback recipient', 8],
    ['buyback recipient ATA', 9],
    ['bonding curve', 10],
    ['bonding curve base vault', 11],
    ['bonding curve quote vault', 12],
    ['creator vault', 16],
    ['creator vault ATA', 17],
    ['sharing config', 18],
    ['global volume accumulator', 19],
    ['user volume accumulator', 20],
    ['user volume accumulator ATA', 21],
    ['fee config', 22],
    ['fee program', 23],
    ['system program', 24],
    ['event authority', 25],
    ['program account', 26],
  ] as const;
  const accepted: string[] = [];

  for (const [label, accountIndex] of cases) {
    const fixture = await signedFixture('pumpfun-buy-v2-plan.json', {
      instructionMutations: [randomAddressMutation(1, accountIndex)],
    });
    try {
      createSignedSimulationRecoveryContext(fixture.input);
      accepted.push(label);
    } catch (error) {
      if (!isContextError(error)) throw error;
    }
  }
  assert.deepEqual(accepted, []);
});

void test('rejects every mutated PumpSwap economic account class', async () => {
  const cases = [
    ['pool', 0],
    ['global config', 2],
    ['pool base vault', 7],
    ['pool quote vault', 8],
    ['fee recipient', 9],
    ['fee recipient ATA', 10],
    ['system program', 13],
    ['associated token program', 14],
    ['event authority', 15],
    ['program account', 16],
    ['creator vault ATA', 17],
    ['creator vault authority', 18],
    ['fee config', 19],
    ['fee program', 20],
    ['cashback quote ATA', 21],
    ['cashback accumulator', 22],
    ['pool v2', 23],
    ['buyback recipient', 24],
    ['buyback recipient ATA', 25],
  ] as const;
  const accepted: string[] = [];

  for (const [label, accountIndex] of cases) {
    const fixture = await signedFixture('pumpswap-sell-plan.json', {
      instructionMutations: [randomAddressMutation(2, accountIndex)],
    });
    try {
      createSignedSimulationRecoveryContext(fixture.input);
      accepted.push(label);
    } catch (error) {
      if (!isContextError(error)) throw error;
    }
  }
  assert.deepEqual(accepted, []);
});

void test('rejects encoded effective privilege mutations across trade, setup and extend',
  async () => {
    const cases = [
      await signedFixture('pumpfun-buy-v2-plan.json', {
        instructionMutations: [{ instructionIndex: 1, accountIndex: 0, isWritable: true }],
      }),
      await signedFixture('pumpfun-buy-v2-plan.json', {
        instructionMutations: [{ instructionIndex: 0, accountIndex: 5, isWritable: true }],
      }),
      await signedFixture('pumpswap-sell-plan.json', {
        instructionMutations: [{ instructionIndex: 0, accountIndex: 2, isWritable: true }],
      }),
    ];
    const accepted: number[] = [];
    for (const [index, fixture] of cases.entries()) {
      try {
        createSignedSimulationRecoveryContext(fixture.input);
        accepted.push(index);
      } catch (error) {
        if (!isContextError(error)) throw error;
      }
    }
    assert.deepEqual(accepted, []);
  });

void test('rejects the fee payer occupying an additional effective signer role', async () => {
  const payer = Keypair.generate();
  const fixture = await signedFixture('pumpfun-buy-v2-plan.json', {
    payer,
    instructionMutations: [{
      instructionIndex: 1,
      accountIndex: 0,
      address: payer.publicKey.toBase58(),
      isSigner: true,
    }],
  });

  assert.throws(() => createSignedSimulationRecoveryContext(fixture.input), isContextError);
});

void test('treats instruction-local close and extend privilege flags by their compiled union',
  async () => {
    const payer = Keypair.generate();
    const blockhash = Keypair.generate().publicKey.toBase58();
    const baseline = await signedFixture('pumpswap-sell-plan.json', { payer, blockhash });
    const locallyMutated = await signedFixture('pumpswap-sell-plan.json', {
      payer,
      blockhash,
      instructionMutations: [
        { instructionIndex: 0, accountIndex: 0, isWritable: false },
        { instructionIndex: 0, accountIndex: 1, isSigner: false },
        { instructionIndex: 3, accountIndex: 0, isWritable: false },
        { instructionIndex: 3, accountIndex: 2, isSigner: false },
      ],
    });

    assert.equal(locallyMutated.artifact.messageHash, baseline.artifact.messageHash);
    assert.doesNotThrow(() => createSignedSimulationRecoveryContext(locallyMutated.input));
  });

void test('rejects ambiguous official trade instructions', async () => {
  const fixture = await signedFixture('pumpfun-buy-v2-plan.json', { duplicateTrade: true });

  assert.throws(
    () => createSignedSimulationRecoveryContext(fixture.input),
    isContextError,
  );
});

void test('rejects mismatched intent, bytes, hash and signature evidence', async () => {
  const fixture = await signedFixture('pumpfun-buy-v2-plan.json');
  const alternate = Keypair.generate().publicKey.toBase58();
  const cases = [
    Object.freeze({
      ...fixture.input,
      claim: Object.freeze({
        ...fixture.input.claim,
        intent: Object.freeze({ ...fixture.input.claim.intent, mint: alternate }),
      }),
    }),
    Object.freeze({
      ...fixture.input,
      artifact: Object.freeze({
        ...fixture.artifact,
        signedTransactionBytes: Object.freeze([
          ...fixture.artifact.signedTransactionBytes.slice(0, -1),
          (fixture.artifact.signedTransactionBytes.at(-1) ?? 0) ^ 1,
        ]),
      }),
    }),
    Object.freeze({
      ...fixture.input,
      artifact: Object.freeze({ ...fixture.artifact, signedTransactionHash: 'f'.repeat(64) }),
    }),
    Object.freeze({
      ...fixture.input,
      artifact: Object.freeze({
        ...fixture.artifact,
        signature: '1'.repeat(64),
      }),
    }),
  ];
  for (const input of cases) {
    assert.throws(() => createSignedSimulationRecoveryContext(input), isContextError);
  }
});

void test('restart rejects a re-signed mutated economic account before any RPC or fence',
  async () => {
    const fixture = await signedFixture('pumpfun-buy-v2-plan.json', {
      instructionMutations: [randomAddressMutation(1, 10)],
    });
    const calls: string[] = [];
    const inspection: ExecutionLiveSignedTransactionInspectionV1 = Object.freeze({
      payloadVersion: 1,
      state: 'PERSISTED',
      stateRevision: 0n,
      artifact: fixture.artifact,
      unsignedSimulation: fixture.unsignedSimulation,
      claim: fixture.input.claim,
    });
    const dependencies = rejectingResumeDependencies(inspection, calls);

    await assert.rejects(resumeLivePersistedTransaction(dependencies, Object.freeze({
      payloadVersion: 1,
      claim: fixture.input.claim,
      runtime: runtimeFor(fixture.artifact.walletPublicKey),
    }), new AbortController().signal), isContextError);

    assert.deepEqual(calls, ['inspect']);
  });

void test('PERSISTED recovery carries its final claim without re-signing or double-sending',
  async () => {
    const fixture = await signedFixture('pumpfun-buy-v2-plan.json');
    let activeClaim: ClaimedExecutionIntent = fixture.input.claim;
    let sends = 0;
    let signedSimulations = 0;
    const inspection: ExecutionLiveSignedTransactionInspectionV1 = Object.freeze({
      payloadVersion: 1,
      state: 'PERSISTED',
      stateRevision: 0n,
      artifact: fixture.artifact,
      unsignedSimulation: fixture.unsignedSimulation,
      claim: activeClaim,
    });
    const dependencies: LiveExecutionWorkerDependencies = Object.freeze({
      repository: Object.freeze({
        persistSigned: () => { throw new Error('recovery must not persist or re-sign'); },
        inspectSignedTransaction: () => Promise.resolve(inspection),
        recordSignedSimulation: (claim: ClaimedExecutionIntent) => {
          assert.equal(claim, activeClaim);
          return Promise.resolve(Object.freeze({
            payloadVersion: 1 as const, artifact: fixture.artifact,
            state: 'SIGNED_SIMULATED' as const, stateRevision: 1n,
          }));
        },
        revokeBeforeSubmission: () => { throw new Error('unexpected revocation'); },
        beginSubmission: (
          input: Parameters<LiveExecutionWorkerDependencies['repository']['beginSubmission']>[0],
        ) => {
          assert.equal(input.claim, activeClaim);
          return Promise.resolve(Object.freeze({
            payloadVersion: 1 as const, artifact: fixture.artifact,
            state: 'SUBMISSION_STARTED' as const, stateRevision: 2n,
          }));
        },
        recordSubmissionOutcome: (claim: ClaimedExecutionIntent) => {
          assert.equal(claim, activeClaim);
          activeClaim = Object.freeze({
            ...activeClaim,
            intent: Object.freeze({
              ...activeClaim.intent,
              status: 'SUBMITTED' as const,
              stateRevision: activeClaim.intent.stateRevision + 1n,
              lastReasonCode: 'SUBMISSION_ACCEPTED' as const,
              updatedAtMs: activeClaim.intent.updatedAtMs + 1,
            }),
          });
          return Promise.resolve(Object.freeze({
            payloadVersion: 1 as const, artifact: fixture.artifact, claim: activeClaim,
          }));
        },
      }),
      signedSimulation: Object.freeze({
        simulate: () => {
          signedSimulations += 1;
          return Promise.resolve(Object.freeze({
            artifactId: fixture.artifact.artifactId,
            signedTransactionHash: fixture.artifact.signedTransactionHash,
          }) as never);
        },
      }),
      submission: Object.freeze({
        submitPersisted: () => {
          sends += 1;
          return Promise.resolve(Object.freeze({ signature: fixture.artifact.signature }));
        },
      }),
      renewBeforeSubmission: (claim: ClaimedExecutionIntent) => {
        assert.equal(claim, activeClaim);
        return Promise.resolve(claim);
      },
      readBlockhashValidity: () => Promise.resolve(Object.freeze({
        payloadVersion: 1 as const, providerId: fixture.artifact.providerId,
        blockhash: fixture.artifact.blockhash, valid: true as const,
        observedBlockHeight: fixture.artifact.lastValidBlockHeight - 1n,
        contextSlot: 127n, observedAtMs: fixture.artifact.signedAtMs + 1,
      })),
    });

    const result = await resumeLivePersistedTransaction(dependencies, Object.freeze({
      payloadVersion: 1,
      claim: activeClaim,
      runtime: runtimeFor(fixture.artifact.walletPublicKey),
    }), new AbortController().signal);

    assert.equal(result.kind, 'ACCEPTED');
    assert.equal(result.claim, activeClaim);
    assert.equal(result.claim.intent.status, 'SUBMITTED');
    assert.equal(result.claim.intent.stateRevision, fixture.input.claim.intent.stateRevision + 1n);
    assert.equal(signedSimulations, 1);
    assert.equal(sends, 1);
  });

void test('rejects malformed unsigned simulation evidence at the recovery boundary', async () => {
  const buy = await signedFixture('pumpfun-buy-v2-plan.json');
  const sell = await signedFixture('pumpswap-sell-plan.json');
  const cases = [
    [buy, { outcome: 'FAILED' }],
    [buy, { estimatedFeeLamports: -1n }],
    [buy, { estimatedFeeLamports: 1n << 64n }],
    [buy, { simulatedBaseDeltaRaw: 1n << 63n }],
    [sell, { simulatedQuoteDeltaRaw: 1n << 63n }],
    [buy, { logsFingerprint: 'A'.repeat(64) }],
    [buy, { logsLineCount: -1 }],
    [buy, { logsLineCount: 1.5 }],
    [buy, { logsLineCount: 257 }],
    [buy, { unexpected: true }],
  ] as const;
  const accepted: number[] = [];

  for (const [index, [fixture, overrides]] of cases.entries()) {
    const unsignedSimulation = Object.freeze({
      ...fixture.unsignedSimulation,
      ...overrides,
    }) as ExecutionSimulationEvidenceV1;
    const input = Object.freeze({
      ...fixture.input,
      unsignedSimulation,
    });
    try {
      createSignedSimulationRecoveryContext(input);
      accepted.push(index);
    } catch (error) {
      if (!isContextError(error)) throw error;
    }
  }

  assert.deepEqual(accepted, []);
});

void test('rejects a non-WSOL quote and an ATA not owned by the artifact wallet', async () => {
  const unsupportedQuote = await signedFixture('pumpfun-buy-v2-plan.json', {
    quoteMint: Keypair.generate().publicKey.toBase58(),
  });
  const wrongAta = await signedFixture('pumpfun-buy-v2-plan.json', { wrongBaseAta: true });

  assert.throws(
    () => createSignedSimulationRecoveryContext(unsupportedQuote.input),
    isContextError,
  );
  assert.throws(
    () => createSignedSimulationRecoveryContext(wrongAta.input),
    isContextError,
  );
});

interface FixtureOptions {
  readonly duplicateTrade?: boolean;
  readonly quoteMint?: string;
  readonly wrongBaseAta?: boolean;
  readonly omittedInstructionIndexes?: readonly number[];
  readonly reverseInstructions?: boolean;
  readonly swapFirstTwoInstructions?: boolean;
  readonly appendUnknownInstruction?: boolean;
  readonly duplicateInstructionIndex?: number;
  readonly instructionMutations?: readonly InstructionMutation[];
  readonly payer?: Keypair;
  readonly blockhash?: string;
}

interface InstructionMutation {
  readonly instructionIndex: number;
  readonly accountIndex: number;
  readonly address?: string;
  readonly isSigner?: boolean;
  readonly isWritable?: boolean;
}

async function signedFixture(
  file: 'pumpfun-buy-v2-plan.json' | 'pumpfun-sell-v2-plan.json' | 'pumpswap-sell-plan.json',
  options: FixtureOptions = {},
) {
  const plan = await loadPlan(file);
  const payer = options.payer ?? Keypair.generate();
  const payerAddress = payer.publicKey.toBase58();
  const baseProgram = plan.identity.baseTokenProgram === 'TOKEN_2022'
    ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const baseAta = getAssociatedTokenAddressSync(
    new PublicKey(plan.identity.mint), payer.publicKey, false, baseProgram,
  ).toBase58();
  const quoteAta = getAssociatedTokenAddressSync(
    NATIVE_MINT, payer.publicKey, false, TOKEN_PROGRAM_ID,
  ).toBase58();
  const oldBaseAta = requiredRole(plan, 'USER_BASE_ATA');
  const oldQuoteAta = requiredRole(plan, 'USER_QUOTE_ATA');
  const oldPayer = new PublicKey(plan.feePayer);
  const oldPumpFunVolume = pumpFunUserVolumeAccumulatorPda(oldPayer);
  const pumpFunVolume = pumpFunUserVolumeAccumulatorPda(payer.publicKey);
  const oldPumpSwapVolume = pumpSwapUserVolumeAccumulatorPda(oldPayer);
  const pumpSwapVolume = pumpSwapUserVolumeAccumulatorPda(payer.publicKey);
  const replacementBaseAta = options.wrongBaseAta === true
    ? Keypair.generate().publicKey.toBase58() : baseAta;
  const replacements = new Map([
    [plan.feePayer, payerAddress],
    [oldBaseAta, replacementBaseAta],
    [oldQuoteAta, quoteAta],
    [oldPumpFunVolume.toBase58(), pumpFunVolume.toBase58()],
    [getAssociatedTokenAddressSync(
      NATIVE_MINT, oldPumpFunVolume, true, TOKEN_PROGRAM_ID,
    ).toBase58(), getAssociatedTokenAddressSync(
      NATIVE_MINT, pumpFunVolume, true, TOKEN_PROGRAM_ID,
    ).toBase58()],
    [oldPumpSwapVolume.toBase58(), pumpSwapVolume.toBase58()],
    [getAssociatedTokenAddressSync(
      NATIVE_MINT, oldPumpSwapVolume, true, TOKEN_PROGRAM_ID,
    ).toBase58(), getAssociatedTokenAddressSync(
      NATIVE_MINT, pumpSwapVolume, true, TOKEN_PROGRAM_ID,
    ).toBase58()],
  ]);
  let instructions = plan.instructions.map((instruction, instructionIndex) => Object.freeze({
    ...instruction,
    accounts: Object.freeze(instruction.accounts.map((account, accountIndex) => {
      const mutation = options.instructionMutations?.find((candidate) =>
        candidate.instructionIndex === instructionIndex
        && candidate.accountIndex === accountIndex);
      return Object.freeze({
        ...account,
        address: mutation?.address ?? replacements.get(account.address) ?? account.address,
        isSigner: mutation?.isSigner ?? account.isSigner,
        isWritable: mutation?.isWritable ?? account.isWritable,
      });
    })),
  }));
  instructions = instructions.filter((_, index) =>
    !(options.omittedInstructionIndexes ?? []).includes(index));
  if (options.reverseInstructions === true) instructions = [...instructions].reverse();
  if (options.swapFirstTwoInstructions === true) {
    const first = instructions[0];
    const second = instructions[1];
    assert.ok(first);
    assert.ok(second);
    instructions = [second, first, ...instructions.slice(2)];
  }
  if (options.appendUnknownInstruction === true) {
    instructions = [...instructions, Object.freeze({
      programId: Keypair.generate().publicKey.toBase58(),
      accounts: Object.freeze([]),
      dataBase64: '',
    })];
  }
  if (options.duplicateInstructionIndex !== undefined) {
    const duplicate = instructions[options.duplicateInstructionIndex];
    assert.ok(duplicate);
    instructions = [...instructions, duplicate];
  }
  const officialTrade = instructions.find((instruction) => {
    const data = Buffer.from(instruction.dataBase64, 'base64');
    return data.length === 24;
  });
  assert.ok(officialTrade);
  const compiledInstructions = options.duplicateTrade === true
    ? Object.freeze([...instructions, officialTrade]) : Object.freeze(instructions);
  const blockhash = options.blockhash ?? Keypair.generate().publicKey.toBase58();
  const compiled = compileInspectedV0Message(Object.freeze({
    feePayer: payerAddress,
    instructions: compiledInstructions,
    recentBlockhash: blockhash,
    maximumTransactionBytes: 1_232,
  }));
  const transaction = VersionedTransaction.deserialize(
    Uint8Array.from(compiled.unsignedTransactionBytes),
  );
  transaction.sign([payer]);
  const signedBytes = transaction.serialize();
  const nowMs = 1_800_000_000_000;
  const quoteMint = options.quoteMint ?? plan.identity.quoteMint;
  const draft = createExecutionIntentDraft({
    strategyId: 'signed-context-test', strategyVersion: 1,
    positionId: 'signed-context-position', logicalCommandId: `signed-context-${file}`,
    mint: plan.identity.mint, side: plan.side,
    venuePolicy: plan.side === 'BUY' ? 'PUMP_FUN_ONLY' : 'CANONICAL_EXIT',
    quoteMint, quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9,
    quoteAmountRaw: plan.side === 'BUY' ? plan.amounts.amountInRaw : null,
    baseAmountRaw: plan.side === 'SELL' ? plan.amounts.amountInRaw : null,
    minimumAmountOutRaw: plan.amounts.protectedAmountOutRaw,
    decisionEventId: `signed-context-decision-${file}`,
    decisionFingerprint: '1'.repeat(64),
    requestedAtMs: nowMs - 1_000, expiresAtMs: nowMs + 60_000,
  });
  const intent: ExecutionIntentV1 = Object.freeze({
    ...draft, status: 'SIGNED_NOT_SUBMITTED', attemptCount: 1, stateRevision: 3n,
    lastReasonCode: 'SIGNATURE_PERSISTED', terminalAtMs: null,
    reconciliationCompletedAtMs: null, purgeAfterMs: null,
    createdAtMs: nowMs - 1_000, updatedAtMs: nowMs - 500,
  });
  const claim = Object.freeze({
    intent, leaseOwner: 'signed-context-test',
    leaseToken: '11111111-1111-4111-8111-111111111111',
    leaseExpiresAtMs: nowMs + 30_000,
  });
  const signature = transaction.signatures[0];
  assert.ok(signature);
  const artifact = createSignedTransactionArtifact({
    payloadVersion: 1, specificationVersion: 1,
    intentId: intent.id, attemptNumber: 1,
    generationId: `execution_wallet_generation_${'2'.repeat(64)}`,
    armamentId: plan.side === 'BUY'
      ? `execution_activation_armament_${'3'.repeat(64)}` : null,
    reservationId: plan.side === 'BUY'
      ? `execution_exposure_reservation_${'4'.repeat(64)}` : null,
    exitAuthorizationId: plan.side === 'SELL'
      ? `execution_exit_authorization_${'5'.repeat(64)}` : null,
    providerId: 'primary', walletPublicKey: payerAddress,
    side: plan.side, effectiveVenue: plan.venue,
    messageHash: compiled.messageHash, buildFingerprint: '6'.repeat(64),
    snapshotFingerprint: plan.identity.snapshotFingerprint,
    quoteFingerprint: plan.identity.quoteFingerprint,
    quoteObservedAtMs: nowMs - 100, quoteExpiresAtMs: nowMs + 5_000,
    blockhash, lastValidBlockHeight: 500n,
    signature: bs58(signature), signedTransactionBytes: signedBytes,
    signedAtMs: nowMs,
  });
  const unsignedSimulation: ExecutionSimulationEvidenceV1 = Object.freeze({
    outcome: 'SUCCESS', snapshotFingerprint: artifact.snapshotFingerprint,
    buildFingerprint: artifact.buildFingerprint, messageHash: artifact.messageHash,
    blockhash: artifact.blockhash, lastValidBlockHeight: artifact.lastValidBlockHeight,
    blockhashContextSlot: 124n, feeContextSlot: 124n,
    estimatedFeeLamports: 5_000n, simulationSlot: 125n,
    simulatedFeePayerLamportDebit: 5_000n, unitsConsumed: 25_000n,
    simulatedBaseDeltaRaw: plan.side === 'BUY'
      ? plan.amounts.expectedAmountOutRaw : -plan.amounts.amountInRaw,
    simulatedQuoteDeltaRaw: plan.side === 'BUY'
      ? -plan.amounts.amountInRaw : plan.amounts.expectedAmountOutRaw,
    logsFingerprint: '7'.repeat(64), logsLineCount: 1,
  });
  return Object.freeze({
    plan, artifact, unsignedSimulation, baseAta, quoteAta,
    input: Object.freeze({ payloadVersion: 1 as const, claim, artifact, unsignedSimulation }),
  });
}

function pumpFunUserVolumeAccumulatorPda(wallet: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([
    Buffer.from('user_volume_accumulator', 'utf8'), wallet.toBuffer(),
  ], PUMP_PROGRAM_ID)[0];
}

function runtimeFor(walletPublicKey: string) {
  return Object.freeze({
    payloadVersion: 1 as const,
    phase: 'CANARY' as const,
    buildHash: 'a'.repeat(64),
    configurationFingerprint: 'b'.repeat(64),
    strategyFingerprint: 'c'.repeat(64),
    walletPublicKey,
    cluster: 'mainnet-beta' as const,
    expectedGenesisHash: walletPublicKey,
    observedGenesisHash: walletPublicKey,
    providerId: 'primary',
  });
}

function rejectingResumeDependencies(
  inspection: ExecutionLiveSignedTransactionInspectionV1,
  calls: string[],
): LiveExecutionWorkerDependencies {
  const unexpected = (label: string): Error => {
    calls.push(label);
    return new Error(`unexpected ${label}`);
  };
  return Object.freeze({
    repository: Object.freeze({
      persistSigned: () => Promise.reject(unexpected('persist')),
      inspectSignedTransaction: () => {
        calls.push('inspect');
        return Promise.resolve(inspection);
      },
      recordSignedSimulation: () => Promise.reject(unexpected('record-signed-simulation')),
      revokeBeforeSubmission: () => Promise.reject(unexpected('revoke-before-submission')),
      beginSubmission: () => Promise.reject(unexpected('begin-submission')),
      recordSubmissionOutcome: () => Promise.reject(unexpected('record-outcome')),
    }),
    signedSimulation: Object.freeze({
      simulate: () => Promise.reject(unexpected('signed-simulate')),
    }),
    submission: Object.freeze({
      submitPersisted: () => Promise.reject(unexpected('rpc-submit')),
    }),
    renewBeforeSubmission: () => Promise.reject(unexpected('renew-before-submission')),
    readBlockhashValidity: () => Promise.reject(unexpected('read-blockhash-validity')),
  });
}

function randomAddressMutation(
  instructionIndex: number,
  accountIndex: number,
): InstructionMutation {
  return Object.freeze({
    instructionIndex,
    accountIndex,
    address: Keypair.generate().publicKey.toBase58(),
  });
}

async function loadPlan(file: string): Promise<UnsignedBuildPlanV1> {
  const document = JSON.parse(await readFile(
    new URL(`fixtures/executor-simulation/${file}`, import.meta.url), 'utf8',
  )) as { readonly plan: Record<string, unknown> };
  const raw = document.plan as unknown as UnsignedBuildPlanV1 & {
    readonly identity: UnsignedBuildPlanV1['identity'] & { readonly snapshotSlot: string };
    readonly amounts: Readonly<Record<keyof UnsignedBuildPlanV1['amounts'], string>>;
  };
  return deepFreeze({
    ...raw,
    identity: { ...raw.identity, snapshotSlot: BigInt(raw.identity.snapshotSlot) },
    amounts: {
      amountInRaw: BigInt(raw.amounts.amountInRaw),
      expectedAmountOutRaw: BigInt(raw.amounts.expectedAmountOutRaw),
      protectedAmountOutRaw: BigInt(raw.amounts.protectedAmountOutRaw),
    },
  }) as UnsignedBuildPlanV1;
}

function requiredRole(plan: UnsignedBuildPlanV1, role: string): string {
  const match = plan.expectedAccounts.find((account) => account.role === role);
  assert.ok(match);
  return match.address;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function bs58(bytes: Uint8Array): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = BigInt(`0x${Buffer.from(bytes).toString('hex')}`);
  let output = '';
  while (value > 0n) {
    output = alphabet.charAt(Number(value % 58n)) + output;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    output = `1${output}`;
  }
  return output;
}

function isContextError(error: unknown): error is SignedSimulationContextError {
  return error instanceof SignedSimulationContextError
    && error.code === 'SIGNED_SIMULATION_CONTEXT_INVALID';
}
