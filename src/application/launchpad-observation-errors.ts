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
  }
}
