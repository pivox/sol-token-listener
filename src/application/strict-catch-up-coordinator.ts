import type { StrictCatchUpScanResult } from './strict-catch-up-scanner.js';

export interface StrictCatchUpScannerPort {
  scan(): Promise<StrictCatchUpScanResult>;
}

export class StrictCatchUpCoordinator {
  private inFlight: Promise<StrictCatchUpScanResult> | null = null;

  public constructor(private readonly scanner: StrictCatchUpScannerPort) {}

  public run(): Promise<StrictCatchUpScanResult> {
    if (this.inFlight !== null) return this.inFlight;

    const run = this.startScan();
    this.inFlight = run;
    void run.then(
      () => { this.clear(run); },
      () => { this.clear(run); },
    );
    return run;
  }

  private startScan(): Promise<StrictCatchUpScanResult> {
    try {
      return Promise.resolve(this.scanner.scan());
    } catch (error) {
      return Promise.resolve().then(() => { throw error; });
    }
  }

  private clear(run: Promise<StrictCatchUpScanResult>): void {
    if (this.inFlight === run) this.inFlight = null;
  }
}
