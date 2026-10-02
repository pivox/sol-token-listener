export interface HydrationAdmissionPermit {
  bindGroup(key: string): void;
  release(): void;
}

export interface HydrationWorkerAdmissionHandle {
  acquire(signal: AbortSignal): Promise<HydrationAdmissionPermit | null>;
  close(): void;
}

export interface HydrationGroupAdmissionOptions {
  readonly now: () => number;
}

export type HydrationGroupAdmissionErrorCode =
  | 'closed'
  | 'invalid_clock'
  | 'invalid_group_key'
  | 'invalid_permit'
  | 'worker_already_outstanding'
  | 'pending_classifier_group_conflict'
  | 'counter_overflow';

/** Neither opaque group keys nor values/errors supplied by the clock are exposed. */
export class HydrationGroupAdmissionContractError extends Error {
  constructor(readonly code: HydrationGroupAdmissionErrorCode) {
    super(`Hydration group admission contract violation: ${code}`);
    this.name = 'HydrationGroupAdmissionContractError';
  }
}

export interface HydrationAdmissionRoleMetrics {
  /** Per consumer request/ticket, including same-group followers; never per RPC fetch. */
  readonly grants: number;
  /** Before-grant aborted/closed requests; completed waits include grants and cancellations. */
  readonly cancellations: number;
  readonly oldestWaitMs: number | null;
  readonly lastWaitMs: number | null;
  readonly maximumWaitMs: number | null;
}

export interface HydrationGroupAdmissionMetrics {
  readonly version: 1;
  readonly enabled: true;
  readonly registeredWorkers: number;
  readonly pendingWorkers: number;
  readonly maximumPendingWorkers: number;
  readonly pendingClassifierGroups: number;
  readonly maximumPendingClassifierGroups: number;
  readonly unboundReservations: number;
  readonly activeGroups: number;
  readonly maximumAdmitted: number;
  readonly worker: HydrationAdmissionRoleMetrics;
  readonly classifier: HydrationAdmissionRoleMetrics;
}

type Role = 'worker' | 'classifier';
interface RoleHistory {
  grants: number;
  cancellations: number;
  lastWaitMs: number | null;
  maximumWaitMs: number | null;
}
interface Worker { open: boolean; outstanding: Waiter | Ticket | null }
interface Waiter {
  readonly role: Role;
  readonly key: string | null;
  readonly worker: Worker | null;
  readonly startedAt: number;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
  readonly resolve: (permit: HydrationAdmissionPermit | null) => void;
  readonly reject: (error: HydrationGroupAdmissionContractError) => void;
}
interface Ticket {
  state: 'unbound' | 'bound' | 'released';
  readonly worker: Worker | null;
}
interface Group { readonly key: string; readonly references: Set<Ticket> }

const history = (): RoleHistory => ({
  grants: 0, cancellations: 0, lastWaitMs: null, maximumWaitMs: null,
});

/** One distinct group OR one unbound worker reservation, independent of RPC/SQL limits. */
export class HydrationGroupAdmission {
  readonly #now: () => number;
  readonly #workers = new Set<Worker>();
  readonly #workerWaiters: Waiter[] = [];
  readonly #classifierWaiters: Waiter[] = [];
  readonly #history = { worker: history(), classifier: history() };
  #lastNow: number | null = null;
  #failure: HydrationGroupAdmissionContractError | null = null;
  #closed = false;
  #unbound: Ticket | null = null;
  #group: Group | null = null;
  #nextContestedRole: Role = 'worker';
  #maximumPendingWorkers = 0;
  #maximumPendingClassifierGroups = 0;
  #maximumAdmitted = 0;

  constructor(options: HydrationGroupAdmissionOptions) {
    this.#now = options.now;
    this.#readClock();
  }

  registerWorker(): HydrationWorkerAdmissionHandle {
    this.#readClock();
    if (this.#closed) throw new HydrationGroupAdmissionContractError('closed');
    const worker: Worker = { open: true, outstanding: null };
    this.#increment(this.#workers.size);
    this.#workers.add(worker);
    return Object.freeze({
      acquire: async (signal: AbortSignal) => {
        const now = this.#readClock();
        if (this.#closed || !worker.open) return null;
        if (worker.outstanding !== null) {
          throw new HydrationGroupAdmissionContractError('worker_already_outstanding');
        }
        return this.#request('worker', null, worker, signal, now);
      },
      close: () => { this.#closeWorker(worker); },
    });
  }

  async acquireClassifier(key: string, signal: AbortSignal):
  Promise<HydrationAdmissionPermit | null> {
    const now = this.#readClock();
    if (this.#closed) return null;
    this.#validateKey(key);
    if (!signal.aborted && this.#group?.key !== key
      && this.#classifierWaiters[0] && this.#classifierWaiters[0].key !== key) {
      throw new HydrationGroupAdmissionContractError('pending_classifier_group_conflict');
    }
    return this.#request('classifier', key, null, signal, now);
  }

  metrics(): HydrationGroupAdmissionMetrics {
    const now = this.#readClock();
    const role = (name: Role, waiters: readonly Waiter[]): HydrationAdmissionRoleMetrics =>
      Object.freeze({
        grants: this.#history[name].grants,
        cancellations: this.#history[name].cancellations,
        oldestWaitMs: waiters[0] ? this.#elapsed(now, waiters[0].startedAt) : null,
        lastWaitMs: this.#history[name].lastWaitMs,
        maximumWaitMs: this.#history[name].maximumWaitMs,
      });
    return Object.freeze({
      version: 1,
      enabled: true,
      registeredWorkers: this.#workers.size,
      pendingWorkers: this.#workerWaiters.length,
      maximumPendingWorkers: this.#maximumPendingWorkers,
      pendingClassifierGroups: this.#classifierWaiters.length > 0 ? 1 : 0,
      maximumPendingClassifierGroups: this.#maximumPendingClassifierGroups,
      unboundReservations: this.#unbound ? 1 : 0,
      activeGroups: this.#group ? 1 : 0,
      maximumAdmitted: this.#maximumAdmitted,
      worker: role('worker', this.#workerWaiters),
      classifier: role('classifier', this.#classifierWaiters),
    });
  }

  close(): void {
    if (this.#closed) return;
    const now = this.#readClock();
    this.#closed = true;
    for (const worker of this.#workers) worker.open = false;
    this.#workers.clear();
    for (const waiter of [...this.#workerWaiters, ...this.#classifierWaiters]) {
      this.#cancel(waiter, now);
    }
  }

  #request(role: Role, key: string | null, worker: Worker | null, signal: AbortSignal,
    now: number): Promise<HydrationAdmissionPermit | null> {
    if (signal.aborted) {
      this.#record(role, 'cancellations', 0);
      return Promise.resolve(null);
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        role, key, worker, startedAt: now, signal, resolve, reject,
        onAbort: () => {
          try {
            this.#cancel(waiter, this.#readClock());
          } catch {
            // Invalid clocks already failed closed and rejected every pending waiter.
          }
        },
      };
      if (worker) worker.outstanding = waiter;
      this.#queue(role).push(waiter);
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      if (signal.aborted) this.#cancel(waiter, now);
      else if (role === 'classifier' && this.#group?.key === key) this.#grant(waiter, now);
      else this.#dispatch(now);
      this.#maximumPendingWorkers = Math.max(this.#maximumPendingWorkers, this.#workerWaiters.length);
      this.#maximumPendingClassifierGroups = Math.max(
        this.#maximumPendingClassifierGroups, this.#classifierWaiters.length > 0 ? 1 : 0,
      );
    });
  }

  #dispatch(now: number): void {
    if (this.#closed || this.#unbound) return;
    if (this.#group) {
      // Same-group consumers are references, not another admission or a fairness turn.
      if (this.#classifierWaiters[0]?.key === this.#group.key) {
        for (const waiter of [...this.#classifierWaiters]) this.#grant(waiter, now);
      }
      return;
    }
    const worker = this.#workerWaiters[0];
    const classifier = this.#classifierWaiters[0];
    if (!worker && !classifier) return;
    const contested = worker !== undefined && classifier !== undefined;
    const role = contested ? this.#nextContestedRole : worker ? 'worker' : 'classifier';
    if (contested) this.#nextContestedRole = role === 'worker' ? 'classifier' : 'worker';
    if (role === 'worker' && worker) this.#grant(worker, now);
    else for (const waiter of [...this.#classifierWaiters]) this.#grant(waiter, now);
  }

  #grant(waiter: Waiter, now: number): void {
    const elapsed = this.#elapsed(now, waiter.startedAt);
    this.#record(waiter.role, 'grants', elapsed);
    this.#removeWaiter(waiter);
    const ticket: Ticket = {
      state: waiter.role === 'worker' ? 'unbound' : 'bound', worker: waiter.worker,
    };
    if (waiter.worker) waiter.worker.outstanding = ticket;
    if (ticket.state === 'unbound') this.#unbound = ticket;
    else {
      const key = waiter.key;
      if (key === null) throw new HydrationGroupAdmissionContractError('invalid_group_key');
      this.#group ??= { key, references: new Set() };
      this.#increment(this.#group.references.size);
      this.#group.references.add(ticket);
    }
    this.#maximumAdmitted = 1;
    const bind = (key: string): void => { this.#bind(ticket, key); };
    const release = (): void => { this.#release(ticket); };
    const permit: HydrationAdmissionPermit = Object.freeze({
      bindGroup(this: HydrationAdmissionPermit, key: string): void {
        if (this !== permit) throw new HydrationGroupAdmissionContractError('invalid_permit');
        bind(key);
      },
      release(this: HydrationAdmissionPermit): void {
        if (this !== permit) throw new HydrationGroupAdmissionContractError('invalid_permit');
        release();
      },
    });
    // Ownership is installed synchronously before any promise continuation can run.
    waiter.resolve(permit);
  }

  #bind(ticket: Ticket, key: string): void {
    if (ticket.state !== 'unbound' || this.#unbound !== ticket) {
      throw new HydrationGroupAdmissionContractError('invalid_permit');
    }
    this.#validateKey(key);
    const now = this.#readClock();
    ticket.state = 'bound';
    this.#unbound = null;
    this.#group = { key, references: new Set([ticket]) };
    this.#dispatch(now);
  }

  #release(ticket: Ticket): void {
    if (ticket.state === 'released') return;
    if (ticket.state === 'unbound') this.#unbound = null;
    else {
      this.#group?.references.delete(ticket);
      if (this.#group?.references.size === 0) this.#group = null;
    }
    ticket.state = 'released';
    if (ticket.worker?.outstanding === ticket) ticket.worker.outstanding = null;
    // A previously granted permit is releasable even after failure or close.
    if (!this.#closed) this.#dispatch(this.#readClock());
  }

  #closeWorker(worker: Worker): void {
    if (!worker.open) return;
    const now = this.#readClock();
    worker.open = false;
    this.#workers.delete(worker);
    const waiter = this.#workerWaiters.find((candidate) => candidate.worker === worker);
    if (waiter) this.#cancel(waiter, now);
  }

  #cancel(waiter: Waiter, now: number): void {
    if (!this.#queue(waiter.role).includes(waiter)) return;
    this.#record(waiter.role, 'cancellations', this.#elapsed(now, waiter.startedAt));
    this.#removeWaiter(waiter);
    if (waiter.worker?.outstanding === waiter) waiter.worker.outstanding = null;
    waiter.resolve(null);
    this.#dispatch(now);
  }

  #removeWaiter(waiter: Waiter): void {
    const queue = this.#queue(waiter.role);
    const index = queue.indexOf(waiter);
    if (index >= 0) queue.splice(index, 1);
    waiter.signal.removeEventListener('abort', waiter.onAbort);
  }

  #queue(role: Role): Waiter[] {
    return role === 'worker' ? this.#workerWaiters : this.#classifierWaiters;
  }

  #record(role: Role, field: 'grants' | 'cancellations', elapsed: number): void {
    const stats = this.#history[role];
    stats[field] = this.#increment(stats[field]);
    stats.lastWaitMs = elapsed;
    stats.maximumWaitMs = Math.max(stats.maximumWaitMs ?? 0, elapsed);
  }

  #increment(value: number): number {
    if (!Number.isSafeInteger(value) || value < 0 || value === Number.MAX_SAFE_INTEGER) {
      throw this.#fail('counter_overflow');
    }
    return value + 1;
  }

  #validateKey(key: string): void {
    if (typeof key !== 'string' || key.length === 0) {
      throw new HydrationGroupAdmissionContractError('invalid_group_key');
    }
  }

  #elapsed(now: number, startedAt: number): number {
    const elapsed = Math.floor(now - startedAt);
    if (!Number.isSafeInteger(elapsed) || elapsed < 0) throw this.#fail('invalid_clock');
    return elapsed;
  }

  #readClock(): number {
    if (this.#failure) throw this.#failure;
    let now: number;
    try { now = this.#now(); } catch { throw this.#fail('invalid_clock'); }
    if (!Number.isFinite(now) || (this.#lastNow !== null && now < this.#lastNow)) {
      throw this.#fail('invalid_clock');
    }
    this.#lastNow = now;
    return now;
  }

  #fail(code: 'invalid_clock' | 'counter_overflow'): HydrationGroupAdmissionContractError {
    this.#failure ??= new HydrationGroupAdmissionContractError(code);
    this.#closed = true;
    for (const worker of this.#workers) worker.open = false;
    this.#workers.clear();
    for (const waiter of [...this.#workerWaiters, ...this.#classifierWaiters]) {
      this.#removeWaiter(waiter);
      if (waiter.worker?.outstanding === waiter) waiter.worker.outstanding = null;
      waiter.reject(this.#failure);
    }
    return this.#failure;
  }
}
