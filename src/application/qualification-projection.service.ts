import { isProxy } from 'node:util/types';
import type { PaperExecutionQuote } from '../domain/paper-trading.js';
import type { QualificationRebuildService } from './qualification-rebuild.service.js';
import type { RebuiltQualification } from './qualification-rebuild.service.js';
import type { MissingCanonicalLaunchPolicy } from '../domain/projection-reconciliation.js';
import type {
  CanonicalQualificationProjection,
  QualificationProjectionRepository,
} from '../ports/qualification-projection-repository.js';

export type { MissingCanonicalLaunchPolicy } from '../domain/projection-reconciliation.js';

export type QualificationProjectionRebuildResult =
  | Readonly<{
    kind: 'UPDATED' | 'UNCHANGED';
    projection: CanonicalQualificationProjection;
  }>
  | Readonly<{
    kind: 'DISSOLVED';
    projection: null;
  }>;

const MISSING_CANONICAL_LAUNCH = Symbol('missing canonical qualification launch');

export class QualificationProjectionLaunchNotFoundError extends Error {
  public constructor(public readonly mint: string) {
    super(`Qualification projection launch not found for mint ${mint}.`);
    this.name = 'QualificationProjectionLaunchNotFoundError';
  }
}

export class QualificationProjectionService {
  private readonly quoteMintAllowlist: readonly string[];

  public constructor(
    private readonly repository: QualificationProjectionRepository,
    private readonly rebuilder: QualificationRebuildService,
    quoteMintAllowlist: readonly string[],
  ) {
    this.quoteMintAllowlist = snapshotQuoteMintAllowlist(quoteMintAllowlist);
  }

  public async rebuild(
    mint: string,
    missingLaunchPolicy: MissingCanonicalLaunchPolicy = 'ERROR',
  ): Promise<QualificationProjectionRebuildResult> {
    assertCanonicalMint(mint, 'Qualification projection mint is invalid.');
    if (!isMissingCanonicalLaunchPolicy(missingLaunchPolicy)) {
      throw new TypeError('Qualification projection missing launch policy is invalid.');
    }
    return this.rebuildCanonical(mint, missingLaunchPolicy, undefined, undefined);
  }

  public async rebuildWithQuotes(
    mint: string,
    buyQuote: PaperExecutionQuote | null,
    reverseSellQuote: PaperExecutionQuote | null,
  ): Promise<QualificationProjectionRebuildResult> {
    return this.rebuildCanonical(mint, 'ERROR', buyQuote, reverseSellQuote);
  }

  public reauthorize(projection: CanonicalQualificationProjection): RebuiltQualification {
    return this.rebuilder.reauthorize(projection);
  }

  private async rebuildCanonical(
    mint: string,
    missingLaunchPolicy: MissingCanonicalLaunchPolicy,
    buyQuote: PaperExecutionQuote | null | undefined,
    reverseSellQuote: PaperExecutionQuote | null | undefined,
  ): Promise<QualificationProjectionRebuildResult> {
    assertCanonicalMint(mint, 'Qualification projection mint is invalid.');
    if (!isMissingCanonicalLaunchPolicy(missingLaunchPolicy)) {
      throw new TypeError('Qualification projection missing launch policy is invalid.');
    }
    const result = await this.repository.transact<
      QualificationProjectionRebuildResult | typeof MISSING_CANONICAL_LAUNCH
    >(mint, async (transaction) => {
      const snapshot = await transaction.loadCanonicalInput(mint);
      if (snapshot === null) {
        if (missingLaunchPolicy === 'ERROR') {
          return MISSING_CANONICAL_LAUNCH;
        }
        await transaction.dissolveCurrent(mint);
        return Object.freeze({ kind:'DISSOLVED' as const, projection:null });
      }
      assertQuotePair(snapshot, buyQuote, reverseSellQuote, this.quoteMintAllowlist);
      const rebuilt = this.rebuilder.rebuild({
        snapshot,
        buyQuote,
        reverseSellQuote,
        upstreamConditions:Object.freeze([Object.freeze({
          code:'UNSUPPORTED_QUOTE_MINT' as const,
          triggered:!snapshot.launch.quoteAssets.some((asset) => (
            this.quoteMintAllowlist.includes(asset.mint)
          )),
        })]),
      });
      const projection: CanonicalQualificationProjection = Object.freeze({
        reportId:rebuilt.reportId,
        sourceEventId:snapshot.asOfEvent.id,
        sourceRawEventId:snapshot.asOfRawEventId,
        evidenceFingerprint:rebuilt.evidenceFingerprint,
        evaluation:rebuilt.evaluation,
        report:rebuilt.report,
        qualificationEvent:rebuilt.event,
      });
      const kind = await transaction.replaceProjection(projection);
      return Object.freeze({ kind,projection });
    });
    if (result === MISSING_CANONICAL_LAUNCH) {
      throw new QualificationProjectionLaunchNotFoundError(mint);
    }
    return result;
  }
}

function assertQuotePair(
  snapshot: Parameters<QualificationRebuildService['rebuild']>[0]['snapshot'],
  buyQuote: PaperExecutionQuote | null | undefined,
  reverseSellQuote: PaperExecutionQuote | null | undefined,
  quoteMintAllowlist: readonly string[],
): void {
  if (buyQuote === undefined && reverseSellQuote === undefined) return;
  if (buyQuote === null && reverseSellQuote === null) return;
  if (buyQuote === null || buyQuote === undefined) {
    throw new TypeError('Qualification projection quote pair is invalid.');
  }
  const buyValid = buyQuote.outputMint === snapshot.mint
    && quoteMintAllowlist.includes(buyQuote.inputMint)
    && snapshot.launch.quoteAssets.some((asset) => asset.mint === buyQuote.inputMint);
  const reverseValid = reverseSellQuote === null || (
    reverseSellQuote?.inputMint === snapshot.mint
    && reverseSellQuote.outputMint === buyQuote.inputMint
    && reverseSellQuote.amountInRaw === buyQuote.minimumAmountOutRaw
  );
  if (!buyValid || !reverseValid) {
    throw new TypeError('Qualification projection quote pair is invalid.');
  }
}

function snapshotQuoteMintAllowlist(value: unknown): readonly string[] {
  if (
    typeof value !== 'object'
    || value === null
    || isProxy(value)
    || !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
  ) throw invalidQuoteMintAllowlist();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lengthDescriptor === undefined
    || !('value' in lengthDescriptor)
    || typeof lengthDescriptor.value !== 'number'
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value <= 0
    || Reflect.ownKeys(value).length !== lengthDescriptor.value + 1
  ) throw invalidQuoteMintAllowlist();
  const length = lengthDescriptor.value;
  const copied: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !('value' in descriptor)
      || typeof descriptor.value !== 'string'
    ) throw invalidQuoteMintAllowlist();
    assertCanonicalMint(descriptor.value, 'Qualification projection quote mint allowlist is invalid.');
    copied.push(descriptor.value);
  }
  if (new Set(copied).size !== copied.length) throw invalidQuoteMintAllowlist();
  return Object.freeze(copied);
}

function assertCanonicalMint(value: unknown, message: string): asserts value is string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 128
    || value.trim() !== value
    || !/^[A-Za-z0-9_-]+$/u.test(value)
  ) throw new TypeError(message);
}

function isMissingCanonicalLaunchPolicy(value: unknown): value is MissingCanonicalLaunchPolicy {
  return value === 'ERROR' || value === 'DISSOLVE_CURRENT';
}

function invalidQuoteMintAllowlist(): TypeError {
  return new TypeError('Qualification projection quote mint allowlist is invalid.');
}
