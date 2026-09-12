import { inheritObservedPipelineOrigin } from '../domain/observed-pipeline-failure.js';

const identities = new WeakMap<object, readonly unknown[]>();

export function matchesLaunchpadObservationError(
  value: unknown,
  ...identity: readonly [LaunchpadObservationStage, string, string, string]
): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const registered = identities.get(value);
  return registered?.every((field, index) => field === identity[index]) ?? false;
}

/** Internal service factory: public wrappers cannot confer trust by carrying a cause. */
export function createLaunchpadObservationError(
  ...args: ConstructorParameters<typeof LaunchpadObservationError>
): LaunchpadObservationError {
  const error = new LaunchpadObservationError(...args);
  inheritObservedPipelineOrigin(error, args[4]);
  return error;
}

export type LaunchpadObservationStage =
  | 'detect_launches'
  | 'decode_trades'
  | 'validate_batch'
  | 'record_batch';

export class LaunchpadObservationError extends Error {
  public override readonly cause: unknown;

  public constructor(
    public readonly stage: LaunchpadObservationStage,
    public readonly source: string,
    public readonly program: string,
    public readonly signature: string,
    cause: unknown,
  ) {
    super(
      `Launchpad observation failed at ${stage} for ${source}/${program} transaction ${signature}`,
      { cause },
    );
    this.name = 'LaunchpadObservationError';
    this.cause = cause;
    identities.set(this, Object.freeze([stage, source, program, signature]));
  }
}
