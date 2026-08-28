import type { StrictCatchUpScanResult } from './strict-catch-up-scanner.js';

export interface StrictCatchUpScannerPort {
  scan(signal: AbortSignal): Promise<StrictCatchUpScanResult>;
}

export class StrictCatchUpCoordinator {
  private inFlight: Promise<StrictCatchUpScanResult> | null = null;

  public constructor(private readonly scanner: StrictCatchUpScannerPort) {}

  public run(signal: AbortSignal): Promise<StrictCatchUpScanResult> {
    if (this.inFlight !== null) return this.inFlight;

    const deferred = deferredStrictCatchUpScan();
    const run = deferred.promise;
    this.inFlight = run;
    void run.then(
      () => { this.clear(run); },
      () => { this.clear(run); },
    );
    try {
      deferred.resolve(this.scanner.scan(signal));
    } catch (error) {
      deferred.reject(error);
    }
    return run;
  }

  private clear(run: Promise<StrictCatchUpScanResult>): void {
    if (this.inFlight === run) this.inFlight = null;
  }
}

interface StrictCatchUpScanDeferred {
  readonly promise: Promise<StrictCatchUpScanResult>;
  readonly resolve: (value: StrictCatchUpScanResult | PromiseLike<StrictCatchUpScanResult>) => void;
  readonly reject: (reason?: unknown) => void;
}

function deferredStrictCatchUpScan(): StrictCatchUpScanDeferred {
  const unavailable = (): never => { throw new Error('Strict catch-up scan deferred is unavailable.'); };
  let resolve: StrictCatchUpScanDeferred['resolve'] = unavailable;
  let reject: StrictCatchUpScanDeferred['reject'] = unavailable;
  const promise = new Promise<StrictCatchUpScanResult>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return Object.freeze({ promise, resolve, reject });
}
