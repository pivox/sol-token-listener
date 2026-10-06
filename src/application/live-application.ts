export interface LiveApplicationComponents {
  readonly controller: {
    restore(): Promise<void>;
    stopEntries(): void;
  };
  readonly listener: {
    start(): Promise<void>;
    close(): Promise<void>;
  };
  readonly acquireWalletLock: () => Promise<{ release(): Promise<void> }>;
  readonly closePool: () => Promise<void>;
}

export interface RunningLiveApplication {
  readonly entriesStopped: boolean;
  stopEntries(): void;
  close(): Promise<void>;
}

/** Shared lifecycle used by the production CLI and offline composition tests. */
export async function startLiveApplication(
  build: () => Promise<LiveApplicationComponents>,
): Promise<RunningLiveApplication> {
  const components = await build();
  let releaseLease: () => Promise<void> = () => Promise.resolve();
  let poolClosed = false;
  let listenerStarted = false;
  let entriesStopped = false;
  let closePromise: Promise<void> | null = null;

  const closePool = async (): Promise<void> => {
    if (poolClosed) return;
    poolClosed = true;
    await components.closePool();
  };
  const cleanupAfterStartFailure = async (): Promise<void> => {
    if (listenerStarted) await components.listener.close();
    await releaseLease();
    await closePool();
  };

  try {
    const lease = await components.acquireWalletLock();
    releaseLease = (): Promise<void> => lease.release();
    await components.controller.restore();
    await components.listener.start();
    listenerStarted = true;
  } catch (error) {
    try { await cleanupAfterStartFailure(); } catch { /* Preserve the startup failure. */ }
    throw error;
  }

  const close = (): Promise<void> => {
    if (closePromise !== null) return closePromise;
    closePromise = (async (): Promise<void> => {
      let failure: Error | undefined;
      try { await components.listener.close(); } catch (error) { failure = asError(error); }
      try { await releaseLease(); } catch (error) { failure ??= asError(error); }
      try { await closePool(); } catch (error) { failure ??= asError(error); }
      if (failure !== undefined) throw failure;
    })();
    return closePromise;
  };

  return Object.freeze({
    get entriesStopped(): boolean { return entriesStopped; },
    stopEntries(): void {
      if (entriesStopped) return;
      entriesStopped = true;
      components.controller.stopEntries();
    },
    close,
  });
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error('Live application cleanup failed.', { cause: value });
}
