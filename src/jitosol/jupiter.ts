import {
  ComputeBudgetProgram, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, TransactionInstruction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

export const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
export const JITOSOL_MINT = new PublicKey('J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn');
export const JUPITER_PROGRAM_ID = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
const EVENT_AUTHORITY = new PublicKey('D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf');
const ROUTE_DISCRIMINATOR = Buffer.from([229, 23, 203, 151, 122, 227, 173, 42]);
const U64_MAX = (1n << 64n) - 1n;
const DEFAULT_TICKET = 3_000_000_000n;

export interface JupiterRoute {
  readonly ammKey: string;
  readonly label: string;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly updateContextSlot: number | null;
}

export interface JupiterQuote {
  readonly raw: Readonly<Record<string, unknown>>;
  readonly inputLamports: bigint;
  readonly expectedOutputAtomic: bigint;
  /** Conservative floor; current API can round its threshold up by one unit. */
  readonly minimumOutputAtomic: bigint;
  readonly slippageBps: number;
  readonly contextSlot: number;
  readonly receivedAtMs: number;
  readonly routePlan: readonly JupiterRoute[];
}

export interface JupiterSwapInstructions {
  setupInstructions: TransactionInstruction[];
  swapInstruction: TransactionInstruction;
  cleanupInstruction: TransactionInstruction | null;
  /** Remote compute-budget instructions are always excluded; caller supplies its fee policy. */
  instructions: TransactionInstruction[];
  addressLookupTableAddresses: PublicKey[];
  destinationTokenAccount: PublicKey;
  sourceTokenAccount: PublicKey;
  remotePriorityFeeLamports: bigint | null;
  remoteComputeUnitLimit: number | null;
}

export interface JupiterClientOptions {
  apiKey?: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  maxResponseBytes?: number;
  ticketLamports?: bigint;
  maxTicketLamports?: bigint;
  slippageBps?: number;
  /** Only the production Jupiter HTTPS origin is accepted. Credentials belong in apiKey. */
  baseUrl?: string;
}

function fail(detail: string): never { throw new Error(`Jupiter ${detail}`); }
function record(value: unknown, detail: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(detail);
  return value as Record<string, unknown>;
}
function boundedArray(value: unknown, maximum: number, detail: string): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) fail(detail);
  return value as unknown[];
}
function integer(value: unknown, minimum: number, maximum: number, detail: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) fail(detail);
  return value;
}
function amount(value: unknown, detail: string): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,19})$/.test(value)) fail(detail);
  const parsed = BigInt(value);
  if (parsed > U64_MAX) fail(detail);
  return parsed;
}
function key(value: unknown, detail: string): PublicKey {
  if (typeof value !== 'string' || value.length > 44) fail(detail);
  try {
    const parsed = new PublicKey(value);
    if (parsed.toBase58() !== value) fail(detail);
    return parsed;
  } catch { return fail(detail); }
}
function routeSlot(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const parsed = amount(value, 'invalid route update slot');
    if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) fail('invalid route update slot');
    return Number(parsed);
  }
  return integer(value, 0, Number.MAX_SAFE_INTEGER, 'invalid route update slot');
}
function freezeJson(value: unknown): void {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freezeJson(item);
    Object.freeze(value);
  }
}

function validateQuote(rawValue: unknown, ticket: bigint, slippage: number, receivedAtMs: number): JupiterQuote {
  const raw = record(rawValue, 'invalid quote response');
  if (raw.inputMint !== SOL_MINT.toBase58() || raw.outputMint !== JITOSOL_MINT.toBase58()
    || raw.swapMode !== 'ExactIn' || raw.slippageBps !== slippage
    || (raw.instructionVersion !== undefined && raw.instructionVersion !== 'V1')) fail('quote does not match request');
  const inputLamports = amount(raw.inAmount, 'invalid quote input amount');
  const expectedOutputAtomic = amount(raw.outAmount, 'invalid quote output amount');
  const apiMinimum = amount(raw.otherAmountThreshold, 'invalid quote minimum output');
  if (inputLamports !== ticket || expectedOutputAtomic === 0n) fail('quote amount does not match request');
  const numerator = expectedOutputAtomic * BigInt(10_000 - slippage);
  const minimumOutputAtomic = numerator / 10_000n;
  const roundedUpMinimum = (numerator + 9_999n) / 10_000n;
  if (minimumOutputAtomic === 0n || apiMinimum > expectedOutputAtomic
    || (apiMinimum !== minimumOutputAtomic && apiMinimum !== roundedUpMinimum)) fail('quote minimum output does not match slippage');
  const contextSlot = integer(raw.contextSlot, 1, Number.MAX_SAFE_INTEGER, 'invalid quote context slot');
  if (raw.platformFee !== undefined && raw.platformFee !== null) {
    const fee = record(raw.platformFee, 'invalid quote platform fee');
    if (amount(fee.amount, 'invalid quote platform fee') !== 0n || fee.feeBps !== 0) fail('quote platform fee is not allowed');
  }
  if (typeof raw.priceImpactPct !== 'string' || raw.priceImpactPct.length > 100
    || !/^-?[0-9]+(?:\.[0-9]+)?$/.test(raw.priceImpactPct)) fail('invalid quote price impact');
  const plan = boundedArray(raw.routePlan, 1, 'quote must use a single direct route');
  if (plan.length !== 1) fail('quote must use a single direct route');
  const routePlan = plan.map((value): JupiterRoute => {
    const leg = record(value, 'invalid quote route');
    const info = record(leg.swapInfo, 'invalid quote route');
    if (leg.percent !== 100 || (leg.bps !== undefined && leg.bps !== null && leg.bps !== 10_000)
      || info.inputMint !== raw.inputMint || info.outputMint !== raw.outputMint
      || amount(info.inAmount, 'invalid route input amount') !== inputLamports
      || amount(info.outAmount, 'invalid route output amount') !== expectedOutputAtomic) fail('quote route does not match request');
    const ammKey = key(info.ammKey, 'invalid route pool').toBase58();
    if (typeof info.label !== 'string' || !/^[ -~]{1,100}$/.test(info.label)) fail('invalid route label');
    if (info.feeAmount !== undefined) amount(info.feeAmount, 'invalid route fee');
    if (info.feeMint !== undefined) key(info.feeMint, 'invalid route fee mint');
    const updateContextSlot = routeSlot(info.updateContextSlot);
    if (updateContextSlot !== null && updateContextSlot > contextSlot) fail('route update slot exceeds quote context');
    return Object.freeze({ ammKey, label: info.label, inputMint: SOL_MINT.toBase58(), outputMint: JITOSOL_MINT.toBase58(), updateContextSlot });
  });
  freezeJson(raw);
  return Object.freeze({ raw, inputLamports, expectedOutputAtomic, minimumOutputAtomic, slippageBps: slippage,
    contextSlot, receivedAtMs, routePlan: Object.freeze(routePlan) });
}

function decodeInstruction(value: unknown, wallet: PublicKey): TransactionInstruction {
  const instruction = record(value, 'invalid instruction');
  const programId = key(instruction.programId, 'invalid instruction program');
  if (typeof instruction.data !== 'string' || instruction.data.length > 4096
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(instruction.data)) fail('invalid instruction data');
  const data = Buffer.from(instruction.data, 'base64');
  if (data.toString('base64') !== instruction.data) fail('invalid instruction data');
  const keys = boundedArray(instruction.accounts, 96, 'invalid instruction accounts').map((value) => {
    const account = record(value, 'invalid instruction account');
    const pubkey = key(account.pubkey, 'invalid instruction account');
    if (typeof account.isSigner !== 'boolean' || typeof account.isWritable !== 'boolean') fail('invalid instruction account flags');
    if (account.isSigner && !pubkey.equals(wallet)) fail('unexpected instruction signer');
    return { pubkey, isSigner: account.isSigner, isWritable: account.isWritable };
  });
  return new TransactionInstruction({ programId, keys, data });
}

function accountMatches(instruction: TransactionInstruction, index: number, expected: PublicKey,
  signer: boolean, writable?: boolean): boolean {
  const account = instruction.keys[index];
  return account !== undefined && account.pubkey.equals(expected) && account.isSigner === signer
    && (writable === undefined || account.isWritable === writable);
}

function validateSetup(instructions: TransactionInstruction[], wallet: PublicKey, source: PublicKey,
  destination: PublicKey, inputLamports: bigint): void {
  let funding = 0;
  let synced = false;
  const created = new Set<string>();
  for (const instruction of instructions) {
    if (instruction.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      const mint = instruction.keys[3]?.pubkey;
      const isSource = mint?.equals(SOL_MINT) === true;
      const expected = isSource ? source : destination;
      if ((!isSource && mint?.equals(JITOSOL_MINT) !== true)
        || ![6, 7].includes(instruction.keys.length)
        || !(instruction.data.length === 0 || (instruction.data.length === 1 && instruction.data[0] === 1))
        || !accountMatches(instruction, 0, wallet, true, true)
        || !accountMatches(instruction, 1, expected, false, true)
        || !accountMatches(instruction, 2, wallet, false, false)
        || !accountMatches(instruction, 3, isSource ? SOL_MINT : JITOSOL_MINT, false, false)
        || !accountMatches(instruction, 4, SystemProgram.programId, false, false)
        || !accountMatches(instruction, 5, TOKEN_PROGRAM_ID, false, false)
        || (instruction.keys.length === 7 && !accountMatches(instruction, 6, SYSVAR_RENT_PUBKEY, false, false))
        || created.has(expected.toBase58()) || (isSource && funding !== 0)) fail('unsafe setup token account creation');
      created.add(expected.toBase58());
    } else if (instruction.programId.equals(SystemProgram.programId)) {
      if (instruction.keys.length !== 2 || instruction.data.length !== 12 || instruction.data.readUInt32LE(0) !== 2
        || instruction.data.readBigUInt64LE(4) !== inputLamports
        || !accountMatches(instruction, 0, wallet, true, true)
        || !accountMatches(instruction, 1, source, false, true)) fail('unsafe setup system instruction');
      funding += 1;
      if (funding !== 1) fail('duplicate SOL funding instruction');
    } else if (instruction.programId.equals(TOKEN_PROGRAM_ID)) {
      if (instruction.data.length !== 1 || instruction.data[0] !== 17 || instruction.keys.length !== 1
        || !accountMatches(instruction, 0, source, false, true) || funding !== 1 || synced) fail('unsafe setup token instruction');
      synced = true;
    } else fail('unexpected setup program');
  }
  if (funding !== 1 || !synced) fail('missing exact SOL funding and sync setup');
}

// Reviewed layouts in official Jupiter IDL, fetched 2026-10-11:
// https://github.com/jup-ag/jupiter-amm-implementation/blob/main/jupiter/idls/jupiter_aggregator.json
// Unknown variants fail closed rather than guessing a trailer offset.
function routeStepEnd(data: Buffer): number {
  const variant = data[12];
  const noFields = [0, 3, 4, 5, 6, 7, 9, 10, 11, 19, 20, 22, 25, 26, 30, 34, 38, 40, 46, 48, 56, 57, 67, 74, 76, 77, 79, 80];
  const boolFields = [8, 17, 18, 21, 23, 58, 61];
  let offset = 13;
  if (variant !== undefined && noFields.includes(variant)) { /* no enum fields */ }
  else if (variant !== undefined && boolFields.includes(variant)) {
    if (data[offset] !== 0 && data[offset] !== 1) fail('invalid route direction');
    offset += 1;
  } else if (variant === 47 || variant === 75) {
    if (variant === 47) {
      if (data[offset] !== 0 && data[offset] !== 1) fail('invalid route direction');
      offset += 1;
      const present = data[offset++];
      // SOL and JitoSOL use classic SPL Token and have no transfer-hook accounts.
      if (present !== 0) fail('unsupported route remaining accounts');
    } else {
      if (data.length < offset + 4 || data.readUInt32LE(offset) !== 0) fail('unsupported route remaining accounts');
      offset += 4;
    }
  } else fail('unsupported route variant');
  if (data[offset] !== 100 || data[offset + 1] !== 0 || data[offset + 2] !== 1) fail('route is not a single direct swap');
  return offset + 3;
}

function validateRoute(instruction: TransactionInstruction, quote: JupiterQuote, wallet: PublicKey,
  source: PublicKey, destination: PublicKey): void {
  const data = instruction.data;
  if (!instruction.programId.equals(JUPITER_PROGRAM_ID) || data.length < 35
    || !data.subarray(0, 8).equals(ROUTE_DISCRIMINATOR) || data.readUInt32LE(8) !== 1) fail('unexpected Jupiter route instruction');
  const offset = routeStepEnd(data);
  if (data.length !== offset + 19 || data.readBigUInt64LE(offset) !== quote.inputLamports
    || data.readBigUInt64LE(offset + 8) !== quote.expectedOutputAtomic
    || data.readUInt16LE(offset + 16) !== quote.slippageBps || data[offset + 18] !== 0
    || data.readBigUInt64LE(offset + 8) * BigInt(10_000 - data.readUInt16LE(offset + 16)) / 10_000n < quote.minimumOutputAtomic) fail('route amounts or slippage do not match quote');
  if (instruction.keys.length < 10 || !accountMatches(instruction, 0, TOKEN_PROGRAM_ID, false, false)
    || !accountMatches(instruction, 1, wallet, true)
    || !accountMatches(instruction, 2, source, false, true)
    || !accountMatches(instruction, 3, destination, false, true)
    || !(accountMatches(instruction, 4, JUPITER_PROGRAM_ID, false, false) || accountMatches(instruction, 4, destination, false, true))
    || !accountMatches(instruction, 5, JITOSOL_MINT, false, false)
    || !accountMatches(instruction, 6, JUPITER_PROGRAM_ID, false, false)
    || !accountMatches(instruction, 7, EVENT_AUTHORITY, false, false)
    || !accountMatches(instruction, 8, JUPITER_PROGRAM_ID, false, false)) fail('route wallet or destination accounts do not match request');
  if (!instruction.keys.slice(9).some((account) => account.pubkey.toBase58() === quote.routePlan[0]?.ammKey)) fail('route pool does not match quote');
}

function validateCleanup(instruction: TransactionInstruction, wallet: PublicKey, source: PublicKey): void {
  if (!instruction.programId.equals(TOKEN_PROGRAM_ID) || instruction.data.length !== 1 || instruction.data[0] !== 9
    || instruction.keys.length !== 3 || !accountMatches(instruction, 0, source, false, true)
    || !accountMatches(instruction, 1, wallet, false, true)
    || !accountMatches(instruction, 2, wallet, true, false)) fail('unsafe cleanup instruction');
}

export class JupiterClient {
  private readonly requestFetch: typeof fetch;
  private readonly now: () => number;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly ticket: bigint;
  private readonly slippage: number;

  constructor(options: JupiterClientOptions = {}) {
    let endpoint: URL;
    try { endpoint = new URL(options.baseUrl ?? 'https://api.jup.ag'); } catch { fail('invalid endpoint'); }
    if (endpoint.origin !== 'https://api.jup.ag' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || !['/', '/swap/v1', '/swap/v1/'].includes(endpoint.pathname)) fail('invalid endpoint');
    this.requestFetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.apiKey = options.apiKey;
    if (this.apiKey !== undefined && (this.apiKey.length === 0 || this.apiKey.length > 4096 || /[\r\n]/.test(this.apiKey))) fail('invalid API key configuration');
    this.timeoutMs = integer(options.timeoutMs ?? 10_000, 1, 60_000, 'invalid timeout configuration');
    this.maxResponseBytes = integer(options.maxResponseBytes ?? 262_144, 1024, 1_048_576, 'invalid response bound');
    this.ticket = options.ticketLamports ?? DEFAULT_TICKET;
    const maxTicket = options.maxTicketLamports ?? DEFAULT_TICKET;
    if (typeof this.ticket !== 'bigint' || typeof maxTicket !== 'bigint' || this.ticket <= 0n || maxTicket <= 0n
      || this.ticket > maxTicket || maxTicket > U64_MAX) fail('invalid ticket amount or ticket cap');
    this.slippage = integer(options.slippageBps ?? 10, 0, 100, 'invalid slippage configuration');
  }

  async getQuote(signal?: AbortSignal): Promise<JupiterQuote> {
    const query = new URLSearchParams({ inputMint: SOL_MINT.toBase58(), outputMint: JITOSOL_MINT.toBase58(),
      amount: this.ticket.toString(), swapMode: 'ExactIn', slippageBps: this.slippage.toString(),
      onlyDirectRoutes: 'true', restrictIntermediateTokens: 'true', instructionVersion: 'V1' });
    const raw = await this.request(`/quote?${query.toString()}`, undefined, signal);
    return validateQuote(raw, this.ticket, this.slippage, integer(this.now(), 0, Number.MAX_SAFE_INTEGER, 'invalid receipt time'));
  }

  async buildSwapInstructions(quote: JupiterQuote, wallet: PublicKey, signal?: AbortSignal): Promise<JupiterSwapInstructions> {
    const checked = validateQuote(quote.raw, this.ticket, this.slippage, quote.receivedAtMs);
    if (quote.inputLamports !== checked.inputLamports || quote.expectedOutputAtomic !== checked.expectedOutputAtomic
      || quote.minimumOutputAtomic !== checked.minimumOutputAtomic || quote.contextSlot !== checked.contextSlot
      || quote.slippageBps !== checked.slippageBps || JSON.stringify(quote.routePlan) !== JSON.stringify(checked.routePlan)) fail('quote metadata was modified');
    if (!PublicKey.isOnCurve(wallet.toBytes())) fail('wallet must be an on-curve public key');
    const source = getAssociatedTokenAddressSync(SOL_MINT, wallet);
    const destination = getAssociatedTokenAddressSync(JITOSOL_MINT, wallet);
    const response = record(await this.request('/swap-instructions', {
      userPublicKey: wallet.toBase58(), quoteResponse: checked.raw, wrapAndUnwrapSol: true,
      useSharedAccounts: false, destinationTokenAccount: destination.toBase58(),
      dynamicComputeUnitLimit: false, dynamicSlippage: false, prioritizationFeeLamports: 0,
      skipUserAccountsRpcCalls: true,
    }, signal), 'invalid swap response');
    if (response.tokenLedgerInstruction !== undefined && response.tokenLedgerInstruction !== null) fail('token ledger instructions are not allowed');
    if (boundedArray(response.otherInstructions ?? [], 0, 'other instructions are not allowed').length !== 0) fail('other instructions are not allowed');
    const compute = boundedArray(response.computeBudgetInstructions ?? [], 4, 'invalid compute instructions');
    for (const value of compute) {
      const ix = decodeInstruction(value, wallet);
      if (!ix.programId.equals(ComputeBudgetProgram.programId) || ix.keys.length !== 0
        || !((ix.data[0] === 2 && ix.data.length === 5) || (ix.data[0] === 3 && ix.data.length === 9))) fail('unexpected compute instruction');
    }
    const setup = boundedArray(response.setupInstructions, 8, 'invalid setup instructions').map((value) => decodeInstruction(value, wallet));
    validateSetup(setup, wallet, source, destination, checked.inputLamports);
    // Passing an explicit destination tells Jupiter to assume it exists. Creating it
    // idempotently here also handles a new bot wallet; gateway must budget its rent.
    if (!setup.some((ix) => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) && ix.keys[1]?.pubkey.equals(destination))) {
      setup.unshift(createAssociatedTokenAccountIdempotentInstruction(wallet, destination, wallet, JITOSOL_MINT));
    }
    const swapInstruction = decodeInstruction(response.swapInstruction, wallet);
    validateRoute(swapInstruction, checked, wallet, source, destination);
    if (response.cleanupInstruction === null || response.cleanupInstruction === undefined) fail('missing WSOL cleanup instruction');
    const cleanupInstruction = decodeInstruction(response.cleanupInstruction, wallet);
    validateCleanup(cleanupInstruction, wallet, source);
    const addresses = boundedArray(response.addressLookupTableAddresses, 32, 'invalid lookup table addresses')
      .map((value) => key(value, 'invalid lookup table address'));
    if (new Set(addresses.map((address) => address.toBase58())).size !== addresses.length) fail('duplicate lookup table addresses');
    const feeValue = response.prioritizationFeeLamports;
    const remotePriorityFeeLamports = feeValue === undefined || feeValue === null ? null
      : typeof feeValue === 'string' ? amount(feeValue, 'invalid priority fee')
        : BigInt(integer(feeValue, 0, Number.MAX_SAFE_INTEGER, 'invalid priority fee'));
    const remoteComputeUnitLimit = response.computeUnitLimit === undefined || response.computeUnitLimit === null ? null
      : integer(response.computeUnitLimit, 1, 1_400_000, 'invalid compute unit limit');
    return { setupInstructions: setup, swapInstruction, cleanupInstruction,
      instructions: [...setup, swapInstruction, cleanupInstruction],
      addressLookupTableAddresses: addresses, destinationTokenAccount: destination, sourceTokenAccount: source,
      remotePriorityFeeLamports, remoteComputeUnitLimit };
  }

  private async request(path: string, body?: Record<string, unknown>, callerSignal?: AbortSignal): Promise<unknown> {
    if (callerSignal?.aborted) fail('request aborted');
    const controller = new AbortController();
    const state = { timedOut: false };
    const abort = (): void => { controller.abort(); };
    callerSignal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { state.timedOut = true; controller.abort(); }, this.timeoutMs);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.apiKey !== undefined) headers['x-api-key'] = this.apiKey;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let rejectAborted: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAborted = (): void => { reject(new Error('Jupiter request aborted')); };
      controller.signal.addEventListener('abort', rejectAborted, { once: true });
    });
    try {
      const result = (async (): Promise<unknown> => {
        const response = await this.requestFetch(`https://api.jup.ag/swap/v1${path}`, {
          method: body === undefined ? 'GET' : 'POST', headers, redirect: 'error', signal: controller.signal,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (!response.ok || response.redirected) fail('request rejected');
        if (response.url && new URL(response.url).origin !== 'https://api.jup.ag') fail('unexpected response origin');
        const size = response.headers.get('content-length');
        if (size !== null && (!/^[0-9]+$/.test(size) || Number(size) > this.maxResponseBytes)) fail('response exceeds size bound');
        if (!response.body) fail('empty response');
        const reader = response.body.getReader();
        const cancelReader = (): void => { void reader.cancel().catch(() => undefined); };
        controller.signal.addEventListener('abort', cancelReader, { once: true });
        let length = 0;
        const chunks: Uint8Array[] = [];
        try {
          let chunk = await reader.read();
          while (!chunk.done) {
            const value: unknown = chunk.value;
            if (!(value instanceof Uint8Array)) fail('invalid response chunk');
            length += value.length;
            if (length > this.maxResponseBytes) { cancelReader(); fail('response exceeds size bound'); }
            chunks.push(value);
            chunk = await reader.read();
          }
        } finally {
          controller.signal.removeEventListener('abort', cancelReader);
          reader.releaseLock();
        }
        try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
        catch { return fail('invalid JSON response'); }
      })();
      return await Promise.race([result, aborted]);
    } catch (error) {
      if (state.timedOut) return fail('request timed out');
      if (callerSignal?.aborted) return fail('request aborted');
      if (error instanceof Error && ['Jupiter request rejected', 'Jupiter unexpected response origin',
        'Jupiter response exceeds size bound', 'Jupiter empty response', 'Jupiter invalid JSON response'].includes(error.message)) throw error;
      return fail('request failed');
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', abort);
      if (rejectAborted) controller.signal.removeEventListener('abort', rejectAborted);
      controller.abort();
    }
  }
}
