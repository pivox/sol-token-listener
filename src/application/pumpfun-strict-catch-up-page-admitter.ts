import { isProxy } from 'node:util/types';
import {
  assertValidCatchUpClassificationReceipt,
  type CatchUpClassificationReceipt,
} from '../domain/catch-up-classification.js';
import { PUMP_PROGRAM_ID } from '../launchpads/pumpfun/constants.js';
import type { ListenerIngestionProgram } from '../ports/listener-ingestion-program.js';
import type {
  StrictCatchUpPageAdmissionResult,
  StrictCatchUpPageAdmitter,
} from '../ports/strict-catch-up-page-admitter.js';
import {
  MAX_CATCH_UP_PAGE_SIZE,
  snapshotCatchUpSignatures,
  type CatchUpSignature,
} from '../solana/rpc/catch-up-source.js';
import {
  mergeCatchUpDiscoveries,
  type MergedCatchUpDiscovery,
} from './catch-up-discovery.js';

export interface PumpFunCatchUpPageClassifier {
  classify(
    discoveries: readonly MergedCatchUpDiscovery[],
    signal: AbortSignal,
  ): Promise<readonly CatchUpClassificationReceipt[]>;
}

export type PumpFunStrictCatchUpPageAdmitterErrorCode =
  | 'ABORTED'
  | 'INVALID_PROGRAM'
  | 'INVALID_PAGE'
  | 'INVALID_RECEIPTS';

export class PumpFunStrictCatchUpPageAdmitterError extends Error {
  public constructor(public readonly code: PumpFunStrictCatchUpPageAdmitterErrorCode) {
    super('Pump.fun strict catch-up page admission failed.');
    this.name = 'PumpFunStrictCatchUpPageAdmitterError';
    Object.freeze(this);
  }
}

/** B3b composes this adapter for provider-affine Pump.fun strict scans when the restart-only flag is enabled. */
export class PumpFunStrictCatchUpPageAdmitter implements StrictCatchUpPageAdmitter {
  public constructor(private readonly classifier: PumpFunCatchUpPageClassifier) {}

  public async admitPage(
    program: ListenerIngestionProgram,
    rows: readonly CatchUpSignature[],
    signal: AbortSignal,
  ): Promise<StrictCatchUpPageAdmissionResult> {
    assertNotAborted(signal);
    assertPumpFunLaunchpadProgram(program);
    let discoveries: readonly MergedCatchUpDiscovery[];
    try {
      const page = snapshotCatchUpSignatures(rows, MAX_CATCH_UP_PAGE_SIZE);
      discoveries = mergeCatchUpDiscoveries([{ program, rows: page }]);
    } catch {
      throw failure('INVALID_PAGE');
    }
    const receipts = await this.classifier.classify(discoveries, signal);
    assertNotAborted(signal);
    return receiptResult(discoveries, receipts);
  }
}

function receiptResult(
  discoveries: readonly MergedCatchUpDiscovery[],
  value: unknown,
): StrictCatchUpPageAdmissionResult {
  try {
    const rawReceipts = snapshotFrozenReceiptArray(value);
    if (rawReceipts.length !== discoveries.length) throw new TypeError();
    const expected = new Map(discoveries.map((row) => [row.signature, row.slot]));
    const receipts: CatchUpClassificationReceipt[] = [];
    let signaturesClassified = 0n;
    let signaturesEnqueued = 0n;
    for (let index = 0; index < discoveries.length; index += 1) {
      const receipt: unknown = rawReceipts[index];
      assertValidCatchUpClassificationReceipt(receipt);
      const slot = expected.get(receipt.signature);
      if (slot === undefined || slot !== receipt.slot) throw new TypeError();
      expected.delete(receipt.signature);
      receipts.push(receipt);
      if (receipt.persistence !== 'ALREADY_ADMITTED') signaturesClassified += 1n;
      if (receipt.admission === 'ENQUEUED') signaturesEnqueued += 1n;
    }
    if (expected.size !== 0 || signaturesEnqueued > signaturesClassified) throw new TypeError();
    return Object.freeze({
      receipts: Object.freeze(receipts),
      signaturesClassified,
      signaturesEnqueued,
    });
  } catch {
    throw failure('INVALID_RECEIPTS');
  }
}

function snapshotFrozenReceiptArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype
    || !Object.isFrozen(value)) throw new TypeError();
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (lengthDescriptor === undefined
    || !('value' in lengthDescriptor)
    || lengthDescriptor.enumerable
    || lengthDescriptor.writable
    || lengthDescriptor.configurable
    || typeof lengthDescriptor.value !== 'number'
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0) throw new TypeError();
  const length = lengthDescriptor.value;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || !keys.includes('length')) throw new TypeError();
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined
      || !('value' in descriptor)
      || !descriptor.enumerable
      || descriptor.writable
      || descriptor.configurable) throw new TypeError();
    snapshot.push(descriptor.value);
  }
  return Object.freeze(snapshot);
}

function assertPumpFunLaunchpadProgram(value: unknown): asserts value is ListenerIngestionProgram {
  try {
    if (typeof value !== 'object' || value === null || isProxy(value) || Array.isArray(value)) {
      throw new TypeError();
    }
    const prototype: object | null = Object.getPrototypeOf(value) as object | null;
    const keys = Reflect.ownKeys(value);
    if ((prototype !== Object.prototype && prototype !== null)
      || keys.length !== 3
      || !keys.includes('key')
      || !keys.includes('family')
      || !keys.includes('id')
      || ownData(value, 'key') !== 'launchpad'
      || ownData(value, 'family') !== 'pumpfun'
      || ownData(value, 'id') !== PUMP_PROGRAM_ID) throw new TypeError();
  } catch {
    throw failure('INVALID_PROGRAM');
  }
}

function ownData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
    throw new TypeError();
  }
  return descriptor.value;
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw failure('ABORTED');
}

function failure(
  code: PumpFunStrictCatchUpPageAdmitterErrorCode,
): PumpFunStrictCatchUpPageAdmitterError {
  return new PumpFunStrictCatchUpPageAdmitterError(code);
}
