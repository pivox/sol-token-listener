export type RpcTransactionStatus = 'RESPONSE_AVAILABLE' | 'RPC_NULL' | 'RPC_ERROR' | 'VERSION_UNSUPPORTED' | 'METADATA_ABSENT' | 'EXECUTED_WITH_ERROR' | 'INVALID_RESPONSE';
export type AccountLifecycle = 'CREATED_DURING_TRANSACTION' | 'PREEXISTING' | 'CLOSED_DURING_TRANSACTION' | 'UNKNOWN';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

type Obj = Record<string, any>;
const object = (value: unknown): Obj | null => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Obj : null;
const rawInteger = (value: unknown): string | null => {
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return null;
};
const address = (value: unknown): string | null => typeof value === 'string' ? value
  : typeof object(value)?.pubkey === 'string' ? object(value)?.pubkey as string : null;

export function classifyRpcTransaction(envelope: unknown): { status: RpcTransactionStatus; result: Obj | null; error: Obj | null } {
  if (envelope === null) return { status: 'RPC_NULL', result: null, error: null };
  const top = object(envelope);
  if (top === null) return { status: 'INVALID_RESPONSE', result: null, error: null };
  const error = object(top.error);
  if (error !== null) {
    const message = typeof error.message === 'string' ? error.message : '';
    const unsupported = error.code === -32015 || (error.code === -32602 && /transaction version|versioned transaction/i.test(message));
    return { status: unsupported ? 'VERSION_UNSUPPORTED' : 'RPC_ERROR', result: null, error };
  }
  if (!Object.prototype.hasOwnProperty.call(top, 'result') || top.result === null) return { status: 'RPC_NULL', result: null, error: null };
  const result = object(top.result);
  if (result === null) return { status: 'INVALID_RESPONSE', result: null, error: null };
  const meta = object(result.meta);
  if (meta === null) return { status: 'METADATA_ABSENT', result, error: null };
  if (meta.err !== null) return { status: 'EXECUTED_WITH_ERROR', result, error: null };
  return { status: 'RESPONSE_AVAILABLE', result, error: null };
}

function instructionRows(result: Obj): { instruction: Obj; location: string }[] {
  const rows: { instruction: Obj; location: string }[] = [];
  const message = object(object(result.transaction)?.message);
  const outer = Array.isArray(message?.instructions) ? message.instructions : [];
  outer.forEach((item: unknown, index: number) => { const value = object(item); if (value) rows.push({ instruction: value, location: `outer:${index}` }); });
  const meta = object(result.meta);
  const inner = Array.isArray(meta?.innerInstructions) ? meta.innerInstructions : [];
  inner.forEach((group: unknown, groupIndex: number) => {
    const instructions = object(group)?.instructions;
    if (Array.isArray(instructions)) instructions.forEach((item: unknown, index: number) => { const value = object(item); if (value) rows.push({ instruction: value, location: `inner:${groupIndex}:${index}` }); });
  });
  return rows;
}

export interface AccountChange { address: string; index: number; preLamportsRaw: string | null; postLamportsRaw: string | null; lamportDeltaRaw: string | null }
export interface TokenChange { account: string | null; accountIndex: number; mint: string; owner: string | null; programId: string | null; decimals: number | null; preAmountRaw: string | null; postAmountRaw: string | null; deltaRaw: string | null; assetClass: 'WRAPPED_SOL' | 'TOKEN' }
export interface AccountLifecycleEvidence { address: string; classification: AccountLifecycle; startLamportsRaw: string | null; endLamportsRaw: string | null; closeDestination: string | null; closeAuthority: string | null }
export interface ParsedTransfer { kind: 'SYSTEM_TRANSFER' | 'TOKEN_TRANSFER'; source: string | null; destination: string | null; authority: string | null; mint: string | null; amountRaw: string | null; feeRaw: string | null; location: string }
export interface ReconciledTransaction {
  signature: string; status: RpcTransactionStatus; commitment: string; slot: string | null; blockTime: number | null;
  version: string | number | null; feePayer: string | null; networkFeeRaw: string | null; networkFeeIncludedInWalletDelta: boolean;
  walletAddress: string; walletLamportDeltaRaw: string | null; accountResolution: 'STATIC_KEYS_ONLY' | 'RESOLVED_WITH_LOADED_ADDRESSES' | 'UNRESOLVED_ACCOUNT_KEYS' | 'NOT_AVAILABLE';
  accounts: AccountChange[]; tokenChanges: TokenChange[]; accountLifecycles: AccountLifecycleEvidence[]; transfers: ParsedTransfer[];
}

function accountKeys(result: Obj, meta: Obj): { keys: string[]; resolution: ReconciledTransaction['accountResolution'] } {
  const message = object(object(result.transaction)?.message);
  const source = Array.isArray(message?.accountKeys) ? message.accountKeys : [];
  const keys = source.map(address);
  if (keys.some(x => x === null)) return { keys: [], resolution: 'UNRESOLVED_ACCOUNT_KEYS' };
  const staticKeys = keys as string[];
  const balances = Array.isArray(meta.preBalances) ? meta.preBalances.length : -1;
  if (staticKeys.length === balances) return { keys: staticKeys, resolution: 'STATIC_KEYS_ONLY' };
  const loaded = object(meta.loadedAddresses);
  const writable = Array.isArray(loaded?.writable) ? loaded.writable.map(address) : [];
  const readonly = Array.isArray(loaded?.readonly) ? loaded.readonly.map(address) : [];
  const combined = [...staticKeys, ...writable, ...readonly];
  if (!combined.some(x => x === null) && combined.length === balances) return { keys: combined as string[], resolution: 'RESOLVED_WITH_LOADED_ADDRESSES' };
  // jsonParsed RPC responses can include lookup-table accounts in accountKeys already.
  if (staticKeys.length === balances) return { keys: staticKeys, resolution: 'RESOLVED_WITH_LOADED_ADDRESSES' };
  return { keys: combined.filter((x): x is string => x !== null), resolution: 'UNRESOLVED_ACCOUNT_KEYS' };
}

function tokenRows(value: unknown): Map<string, Obj> {
  const result = new Map<string, Obj>();
  if (!Array.isArray(value)) return result;
  for (const item of value) {
    const row = object(item); if (!row || !Number.isInteger(row.accountIndex) || typeof row.mint !== 'string') continue;
    const amount = rawInteger(object(row.uiTokenAmount)?.amount);
    result.set(`${row.accountIndex}:${row.mint}:${String(row.owner ?? '')}:${String(row.programId ?? '')}`, { ...row, amount });
  }
  return result;
}

function parseTransfers(rows: { instruction: Obj; location: string }[]): ParsedTransfer[] {
  const found: ParsedTransfer[] = [];
  for (const { instruction, location } of rows) {
    const parsed = object(instruction.parsed); const info = object(parsed?.info); const type = parsed?.type;
    if (!parsed || !info) continue;
    if (instruction.program === 'system' && (type === 'transfer' || type === 'transferWithSeed')) {
      found.push({ kind: 'SYSTEM_TRANSFER', source: address(info.source), destination: address(info.destination), authority: address(info.source), mint: null, amountRaw: rawInteger(info.lamports), feeRaw: null, location });
    } else if ((instruction.program === 'spl-token' || instruction.program === 'spl-token-2022') && ['transfer', 'transferChecked', 'transferCheckedWithFee'].includes(String(type))) {
      const tokenAmount = object(info.tokenAmount);
      found.push({ kind: 'TOKEN_TRANSFER', source: address(info.source), destination: address(info.destination), authority: address(info.authority),
        mint: typeof info.mint === 'string' ? info.mint : null, amountRaw: rawInteger(tokenAmount?.amount ?? info.amount),
        feeRaw: rawInteger(object(info.fee)?.amount ?? info.feeAmount), location });
    }
  }
  return found;
}

export function reconcileTransaction(signature: string, envelope: unknown, walletAddress: string, commitment = 'finalized'): ReconciledTransaction {
  const classified = classifyRpcTransaction(envelope);
  const empty: ReconciledTransaction = { signature, status: classified.status, commitment, slot: null, blockTime: null, version: null,
    feePayer: null, networkFeeRaw: null, networkFeeIncludedInWalletDelta: false, walletAddress, walletLamportDeltaRaw: null,
    accountResolution: 'NOT_AVAILABLE', accounts: [], tokenChanges: [], accountLifecycles: [], transfers: [] };
  const result = classified.result;
  if (!result) return empty;
  const meta = object(result.meta);
  if (!meta) return { ...empty, slot: rawInteger(result.slot), blockTime: Number.isSafeInteger(result.blockTime) ? result.blockTime : null, version: result.version ?? null };
  const resolved = accountKeys(result, meta);
  const pre = Array.isArray(meta.preBalances) ? meta.preBalances : [];
  const post = Array.isArray(meta.postBalances) ? meta.postBalances : [];
  const accounts: AccountChange[] = resolved.keys.map((key, index) => {
    const before = rawInteger(pre[index]); const after = rawInteger(post[index]);
    return { address: key, index, preLamportsRaw: before, postLamportsRaw: after,
      lamportDeltaRaw: before === null || after === null ? null : String(BigInt(after) - BigInt(before)) };
  });
  const keys = resolved.keys;
  const previous = tokenRows(meta.preTokenBalances); const next = tokenRows(meta.postTokenBalances);
  const tokenIds = new Set([...previous.keys(), ...next.keys()]);
  const tokenChanges: TokenChange[] = [...tokenIds].map(id => {
    const before = previous.get(id); const after = next.get(id); const row = after ?? before as Obj;
    const preAmountRaw = before?.amount ?? null; const postAmountRaw = after?.amount ?? null;
    const same = preAmountRaw !== null && postAmountRaw !== null;
    return { account: keys[row.accountIndex] ?? null, accountIndex: row.accountIndex, mint: row.mint, owner: row.owner ?? null, programId: row.programId ?? null,
      decimals: object(row.uiTokenAmount)?.decimals ?? null, preAmountRaw, postAmountRaw,
      deltaRaw: same ? String(BigInt(postAmountRaw) - BigInt(preAmountRaw)) : null, assetClass: row.mint === WSOL_MINT ? 'WRAPPED_SOL' : 'TOKEN' };
  });
  const instructions = instructionRows(result);
  const created = new Set<string>(); const closed = new Map<string, { destination: string | null; authority: string | null }>();
  for (const { instruction } of instructions) {
    const parsed = object(instruction.parsed); const info = object(parsed?.info);
    if (!parsed || !info) continue;
    if (instruction.program === 'system' && ['createAccount', 'createAccountWithSeed'].includes(String(parsed.type))) {
      const account = address(info.newAccount); if (account) created.add(account);
    }
    if ((instruction.program === 'spl-token' || instruction.program === 'spl-token-2022') && parsed.type === 'closeAccount') {
      const account = address(info.account); if (account) closed.set(account, { destination: address(info.destination), authority: address(info.owner ?? info.authority) });
    }
  }
  const tokenAccountAddresses = new Set(tokenChanges.map(row => row.account).filter((x): x is string => x !== null));
  for (const account of created) tokenAccountAddresses.add(account);
  for (const account of closed.keys()) tokenAccountAddresses.add(account);
  const accountLifecycles: AccountLifecycleEvidence[] = [...tokenAccountAddresses].map(account => {
    const change = accounts.find(x => x.address === account); const close = closed.get(account);
    let classification: AccountLifecycle = 'UNKNOWN';
    if (close && change?.postLamportsRaw === '0') classification = 'CLOSED_DURING_TRANSACTION';
    else if (created.has(account) && change?.preLamportsRaw === '0' && change.postLamportsRaw !== null && BigInt(change.postLamportsRaw) > 0n) classification = 'CREATED_DURING_TRANSACTION';
    else if (change?.preLamportsRaw !== null && change?.preLamportsRaw !== undefined && BigInt(change.preLamportsRaw) > 0n) classification = 'PREEXISTING';
    return { address: account, classification, startLamportsRaw: change?.preLamportsRaw ?? null, endLamportsRaw: change?.postLamportsRaw ?? null,
      closeDestination: close?.destination ?? null, closeAuthority: close?.authority ?? null };
  });
  const walletIndex = keys.indexOf(walletAddress);
  const payer = keys[0] ?? null;
  const walletDelta = walletIndex < 0 ? null : accounts[walletIndex]?.lamportDeltaRaw ?? null;
  const networkFee = rawInteger(meta.fee);
  return { signature, status: classified.status, commitment,
    slot: rawInteger(result.slot), blockTime: Number.isSafeInteger(result.blockTime) ? result.blockTime : null, version: result.version ?? null,
    feePayer: payer, networkFeeRaw: networkFee, networkFeeIncludedInWalletDelta: walletIndex === 0 && walletDelta !== null,
    walletAddress, walletLamportDeltaRaw: walletDelta, accountResolution: resolved.resolution, accounts, tokenChanges,
    accountLifecycles, transfers: parseTransfers(instructions) };
}

export interface TrackedAccountWindow { address: string; startLamportsRaw: string | null; endLamportsRaw: string | null; lifecycle: 'PREEXISTING' | 'CREATED_DURING_SESSION' | 'CLOSED_DURING_SESSION' | 'UNKNOWN' }
export interface SessionLedgerInput {
  wallet: string; walletStartLamportsRaw: string | null; walletEndLamportsRaw: string | null;
  transactions: readonly ReconciledTransaction[]; trackedAccounts: readonly TrackedAccountWindow[];
  externalFlowCoverage: 'COMPLETE' | 'INCOMPLETE'; residualPositionValueRaw: string | null;
  movementReviews?: readonly { signature: string; location: string; classification: 'UNRELATED_EXTERNAL' | 'INTERNAL' | 'UNKNOWN' }[];
}
export function reconcileSession(input: SessionLedgerInput): {
  walletCashDeltaRaw: string | null; externalWalletFlowRaw: string | null; immobilizedDeltaRaw: string | null;
  residualPositionValueRaw: string | null; networkFeesRaw: string | null; networkFeesAlreadyIncludedInCashDelta: boolean;
  economicNetRaw: string | null; status: 'RECONCILED' | 'INCOMPLETE'; trackedAccounts: TrackedAccountWindow[];
  externalTransferCandidates: { signature: string; location: string; source: string | null; destination: string | null; amountRaw: string }[];
} {
  const valid = (x: string | null): x is string => x !== null && /^-?\d+$/.test(x);
  const walletCashDeltaRaw = valid(input.walletStartLamportsRaw) && valid(input.walletEndLamportsRaw)
    ? String(BigInt(input.walletEndLamportsRaw) - BigInt(input.walletStartLamportsRaw)) : null;
  const windowsKnown = input.trackedAccounts.every(x => valid(x.startLamportsRaw) && valid(x.endLamportsRaw));
  const immobilizedDeltaRaw = windowsKnown ? String(input.trackedAccounts.reduce((sum, x) => sum + BigInt(x.endLamportsRaw as string) - BigInt(x.startLamportsRaw as string), 0n)) : null;
  const feeKnown = input.transactions.every(x => x.networkFeeRaw !== null);
  const networkFeesRaw = feeKnown ? String(input.transactions.reduce((sum, x) => sum + BigInt(x.networkFeeRaw as string), 0n)) : null;
  const internal = new Set([input.wallet, ...input.trackedAccounts.map(x => x.address)]);
  const externalCandidates = input.transactions.flatMap(tx => tx.transfers.filter(x => {
    if (x.kind !== 'SYSTEM_TRANSFER' || x.amountRaw === null) return false;
    const fromWallet = x.source === input.wallet && x.destination !== null && !internal.has(x.destination);
    const toWallet = x.destination === input.wallet && x.source !== null && !internal.has(x.source);
    return fromWallet || toWallet;
  }).map(x => ({ signature: tx.signature, location: x.location, source: x.source, destination: x.destination, amountRaw: x.amountRaw as string })));
  const reviews = new Map((input.movementReviews ?? []).map(x => [`${x.signature}:${x.location}`, x.classification]));
  const candidatesReviewed = externalCandidates.every(x => reviews.has(`${x.signature}:${x.location}`) && reviews.get(`${x.signature}:${x.location}`) !== 'UNKNOWN');
  const externalWalletFlowRaw = input.externalFlowCoverage === 'COMPLETE' && candidatesReviewed
    ? String(externalCandidates.reduce((sum, x) => sum + (reviews.get(`${x.signature}:${x.location}`) === 'UNRELATED_EXTERNAL'
      ? x.destination === input.wallet ? BigInt(x.amountRaw) : -BigInt(x.amountRaw) : 0n), 0n)) : null;
  const reconciled = walletCashDeltaRaw !== null && externalWalletFlowRaw !== null && immobilizedDeltaRaw !== null && valid(input.residualPositionValueRaw)
    && input.transactions.every(x => ['RESPONSE_AVAILABLE', 'EXECUTED_WITH_ERROR'].includes(x.status));
  const economicNetRaw = reconciled ? String(BigInt(walletCashDeltaRaw as string) - BigInt(externalWalletFlowRaw as string)
    + BigInt(immobilizedDeltaRaw as string) + BigInt(input.residualPositionValueRaw as string)) : null;
  return { walletCashDeltaRaw, externalWalletFlowRaw, immobilizedDeltaRaw, residualPositionValueRaw: input.residualPositionValueRaw,
    networkFeesRaw, networkFeesAlreadyIncludedInCashDelta: true, economicNetRaw,
    status: economicNetRaw === null ? 'INCOMPLETE' : 'RECONCILED', trackedAccounts: [...input.trackedAccounts], externalTransferCandidates: externalCandidates };
}
