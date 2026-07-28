export interface HeartbeatSnapshot {
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly lastHttpSlot: string | null;
  readonly lastWebsocketSlot: string | null;
  readonly lastFinalizedSlot: string | null;
  readonly lastSignature: string | null;
  readonly pendingTransactions: number;
  readonly activeSessions: number;
  readonly lagSlots: string | null;
}

export class Heartbeat {
  private readonly startedAtMs = Date.now();
  private updatedAtMs = this.startedAtMs;
  private lastHttpSlot: bigint | null = null;
  private lastWebsocketSlot: bigint | null = null;
  private lastFinalizedSlot: bigint | null = null;
  private lastSignature: string | null = null;
  private pendingTransactions = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly activeSessionCount: () => number) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      this.updatedAtMs = Date.now();
    }, 5_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  http(slot: bigint): void {
    this.lastHttpSlot = slot;
    this.updatedAtMs = Date.now();
  }

  finalized(slot: bigint): void {
    this.lastFinalizedSlot = slot;
    this.updatedAtMs = Date.now();
  }

  websocket(slot: bigint, signature: string, pendingTransactions: number): void {
    this.lastWebsocketSlot = slot;
    this.lastSignature = signature;
    this.pendingTransactions = pendingTransactions;
    this.updatedAtMs = Date.now();
  }

  get(): HeartbeatSnapshot {
    const lag = this.lastHttpSlot !== null && this.lastWebsocketSlot !== null
      ? this.lastHttpSlot - this.lastWebsocketSlot
      : null;
    return {
      startedAt: new Date(this.startedAtMs).toISOString(),
      updatedAt: new Date(this.updatedAtMs).toISOString(),
      lastHttpSlot: this.lastHttpSlot?.toString() ?? null,
      lastWebsocketSlot: this.lastWebsocketSlot?.toString() ?? null,
      lastFinalizedSlot: this.lastFinalizedSlot?.toString() ?? null,
      lastSignature: this.lastSignature,
      pendingTransactions: this.pendingTransactions,
      activeSessions: this.activeSessionCount(),
      lagSlots: lag?.toString() ?? null,
    };
  }
}
