import { classifyRpcTransaction, reconcileTransaction, type ReconciledTransaction } from './transaction-evidence.js';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
type Row = Readonly<Record<string, unknown>>;

export interface LiveSessionReconciliationInput {
  readonly sessionId: string;
  readonly wallet: string;
  readonly sessionRows: readonly Row[];
  readonly signatureIndex: readonly Row[];
  readonly rpcAttempts: readonly Row[];
}

/** Reconciles a single exported live session without treating absent RPC data as zero. */
export function buildLiveSessionReconciliation(input: LiveSessionReconciliationInput): Readonly<Record<string, unknown>> {
  const sessionRows = input.sessionRows.filter((row) => row.sessionId === input.sessionId && row.wallet === input.wallet);
  const indexBySignature = new Map<string, Row>();
  for (const row of input.signatureIndex) if (typeof row.signature === 'string') indexBySignature.set(row.signature, row);
  const latestBySignature = new Map<string, Row>();
  for (const row of input.rpcAttempts) {
    if (typeof row.signature !== 'string') continue;
    const previous = latestBySignature.get(row.signature);
    if (previous === undefined || numeric(row.attempt) >= numeric(previous.attempt)) latestBySignature.set(row.signature, row);
  }

  const transactions: (ReconciledTransaction & Row)[] = [];
  for (const [signature, attempt] of latestBySignature) {
    const classified = classifyRpcTransaction(attempt.httpResponse);
    const ledger = reconcileTransaction(signature, attempt.httpResponse, input.wallet,
      typeof object(attempt.parameters)?.commitment === 'string' ? String(object(attempt.parameters)?.commitment) : 'finalized');
    const collectionStatus = typeof attempt.status === 'string' ? attempt.status : classified.status;
    transactions.push({ ...ledger, status: collectionStatus === 'RPC_ERROR' ? 'RPC_ERROR' : ledger.status,
      collectionStatus,
      retrievedAt: attempt.retrievedAt ?? null, links: indexBySignature.get(signature)?.links ?? [],
      transportErrorCategory: attempt.transportErrorCategory ?? null, httpStatus: attempt.httpStatus ?? null });
  }

  const transactionBySignature = new Map(transactions.map((row) => [row.signature, row]));
  const positions = new Map<string, Row[]>();
  for (const row of sessionRows) {
    if (typeof row.positionId !== 'string') continue;
    positions.set(row.positionId, [...(positions.get(row.positionId) ?? []), row]);
  }
  const positionRows = [...positions].map(([positionId, orders]) => {
    const mint = firstText(orders, 'mint');
    const snapshots = orders.map((row) => object(row.positionSnapshot)).filter((row): row is Row => row !== null);
    const latestSnapshot = snapshots.at(-1) ?? null;
    let acquired = 0n;
    let sold = 0n;
    let quantityCoverage = true;
    const orderResults = orders.map((order) => {
      const signature = typeof order.signature === 'string' ? order.signature : null;
      const transaction = signature === null ? undefined : transactionBySignature.get(signature);
      const side = order.side === 'BUY' || order.side === 'SELL' ? order.side : null;
      const status = typeof order.orderStatus === 'string' ? order.orderStatus : 'UNKNOWN_STATUS';
      const matching = transaction?.tokenChanges.filter((change) => change.mint === mint && change.owner === input.wallet) ?? [];
      const delta = transaction?.status === 'RESPONSE_AVAILABLE' && matching.length > 0 && matching.every((change) => change.deltaRaw !== null)
        ? matching.reduce((sum, change) => sum + BigInt(change.deltaRaw as string), 0n) : null;
      const confirmedExecution = status === 'CONFIRMED';
      if (confirmedExecution && (signature === null || delta === null || side === null)) quantityCoverage = false;
      if (!['CONFIRMED', 'FAILED', 'EXPIRED', 'PREPARED'].includes(status)) quantityCoverage = false;
      if (status === 'PREPARED' && signature !== null) quantityCoverage = false;
      if (status === 'FAILED' && transaction?.status !== 'EXECUTED_WITH_ERROR') quantityCoverage = false;
      if (status === 'EXPIRED') quantityCoverage = false;
      if (confirmedExecution && delta !== null && side === 'BUY' && delta > 0n) acquired += delta;
      if (confirmedExecution && delta !== null && side === 'SELL' && delta < 0n) sold += -delta;
      return { orderId: order.orderId ?? null, side, status, signature,
        rpcStatus: transaction?.status ?? (signature === null ? 'NO_SIGNATURE' : 'NOT_COLLECTED'),
        acquiredDeltaRaw: confirmedExecution && side === 'BUY' ? delta?.toString() ?? null : null,
        soldDeltaRaw: confirmedExecution && side === 'SELL' && delta !== null ? (-delta).toString() : null,
        fillSnapshot: order.fillSnapshot ?? null };
    });
    const attributedRemaining = quantityCoverage ? acquired - sold : null;
    return { positionId, mint, orders: orderResults,
      acquiredFromConfirmedSignaturesRaw: acquired.toString(),
      soldFromConfirmedSignaturesRaw: sold.toString(),
      remainingFromOrderDeltasRaw: attributedRemaining?.toString() ?? null,
      persistedPositionSnapshot: latestSnapshot === null ? null : {
        status: latestSnapshot.status ?? null,
        acquiredRaw: latestSnapshot.acquiredRaw ?? null,
        remainingRaw: latestSnapshot.remainingRaw ?? null,
        buySignature: latestSnapshot.buySignature ?? null,
        sellSignature: latestSnapshot.sellSignature ?? null,
      },
      quantityStatus: quantityCoverage ? 'ORDER_DELTAS_AVAILABLE' : 'INCOMPLETE_RPC_OR_ORDER_STATUS' };
  });

  const walletTransactions = transactions.filter((row) => row.feePayer === input.wallet);
  const indexedSignatures = input.signatureIndex.flatMap((row) => typeof row.signature === 'string' ? [row.signature] : []);
  const allIndexedMetadataAvailable = indexedSignatures.length > 0 && indexedSignatures.every((signature) => {
    const transaction = transactionBySignature.get(signature);
    return transaction !== undefined && ['RESPONSE_AVAILABLE', 'EXECUTED_WITH_ERROR'].includes(transaction.status);
  });
  const completeWalletDelta = allIndexedMetadataAvailable && walletTransactions.every((row) => row.walletLamportDeltaRaw !== null);
  const transactionLamportFlow = completeWalletDelta
    ? walletTransactions.reduce((sum, row) => sum + BigInt(row.walletLamportDeltaRaw as string), 0n).toString()
    : null;
  const feesKnown = allIndexedMetadataAvailable && walletTransactions.every((row) => row.networkFeeRaw !== null);
  const feesRaw = feesKnown ? walletTransactions.reduce((sum, row) => sum + BigInt(row.networkFeeRaw as string), 0n).toString() : null;
  const wrappedSolDelta = transactions.flatMap((row) => row.tokenChanges)
    .filter((change) => change.mint === WSOL_MINT && change.owner === input.wallet);
  const wsolKnown = allIndexedMetadataAvailable && wrappedSolDelta.every((change) => change.deltaRaw !== null);
  const wsolDeltaRaw = wsolKnown ? wrappedSolDelta.reduce((sum, change) => sum + BigInt(change.deltaRaw as string), 0n).toString() : null;
  const accountEvents = transactions.flatMap((row) => row.accountLifecycles.map((lifecycle) => ({
    signature: row.signature, ...lifecycle,
    balanceDeltaRaw: lifecycle.startLamportsRaw !== null && lifecycle.endLamportsRaw !== null
      ? String(BigInt(lifecycle.endLamportsRaw) - BigInt(lifecycle.startLamportsRaw)) : null,
    refundDestination: lifecycle.classification === 'CLOSED_DURING_TRANSACTION' ? lifecycle.closeDestination : null,
    refundCandidateRaw: lifecycle.classification === 'CLOSED_DURING_TRANSACTION' ? lifecycle.startLamportsRaw : null,
    refundDestinationLamportDeltaRaw: lifecycle.classification === 'CLOSED_DURING_TRANSACTION' && lifecycle.closeDestination !== null
      ? row.accounts.find((account) => account.address === lifecycle.closeDestination)?.lamportDeltaRaw ?? null : null,
  })));

  return Object.freeze({ schema: 'live_session_reconciliation.v1', sessionId: input.sessionId, wallet: input.wallet,
    orderAttempts: sessionRows.filter((row) => typeof row.orderId === 'string').map((row) => ({ orderId: row.orderId ?? null, positionId: row.positionId ?? null,
      side: row.side ?? null, status: row.orderStatus ?? null, signature: row.signature ?? null,
      mint: row.mint ?? null, createdAt: row.createdAt ?? null })),
    sessionEvidenceRowsWithoutOrderId: sessionRows.filter((row) => typeof row.orderId !== 'string').map((row) => ({
      event: row.event ?? null, signature: row.signature ?? null,
    })),
    rpc: { indexedSignatures: input.signatureIndex.length, retrievedSignatures: latestBySignature.size,
      transactionsWithUsableMetadata: transactions.filter((row) => row.status === 'RESPONSE_AVAILABLE').length,
      statuses: countBy(transactions, (row) => row.status) },
    positions: positionRows,
    cashAndFees: { collectedWalletLamportDeltaRaw: transactionLamportFlow, scope: 'collected wallet fee-payer signatures only; not full session cash delta',
      observedNetworkFeesRaw: feesRaw, feesIncludedInWalletLamportDelta: true, feesSubtractedAgain: false,
      networkFeeCoverage: feesKnown ? 'COMPLETE_FOR_RETRIEVED_WALLET_FEE_PAYER_TRANSACTIONS' : 'INCOMPLETE_OR_UNKNOWN',
      wrappedSolTokenDeltaRaw: wsolDeltaRaw, wrappedSolIsReportedSeparately: true,
      sessionStartBalanceRaw: null, sessionEndBalanceRaw: null, externalFlowCoverage: 'UNKNOWN', economicResultLamportsRaw: null },
    accountFundingAndRefunds: { transactionLifecycleEvents: accountEvents,
      historicalSessionEndBalances: 'UNKNOWN unless captured by account snapshots; current account state is not substituted' },
    transactions: transactions.map((row) => ({ signature: row.signature, status: row.status, slot: row.slot,
      feePayer: row.feePayer, networkFeeRaw: row.networkFeeRaw,
      networkFeeIncludedInWalletDelta: row.networkFeeIncludedInWalletDelta,
      walletLamportDeltaRaw: row.walletLamportDeltaRaw, accounts: row.accounts, accountResolution: row.accountResolution,
      tokenChanges: row.tokenChanges, accountLifecycles: row.accountLifecycles,
      transfers: row.transfers, retrievedAt: row.retrievedAt, collectionStatus: row.collectionStatus,
      transportErrorCategory: row.transportErrorCategory, httpStatus: row.httpStatus })),
    completeness: { status: 'INCOMPLETE', economicResultReason: 'This export does not contain trusted session-boundary wallet balances, complete external-flow coverage, and priced residual positions.' } });
}

function object(value: unknown): Row | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Row : null; }
function numeric(value: unknown): number { return typeof value === 'number' && Number.isSafeInteger(value) ? value : 0; }
function firstText(rows: readonly Row[], field: string): string | null { const row = rows.find((item) => typeof item[field] === 'string'); return row ? String(row[field]) : null; }
function countBy(rows: readonly { readonly status: string }[], key: (row: { readonly status: string }) => string): Readonly<Record<string, number>> {
  const count: Record<string, number> = {};
  for (const row of rows) count[key(row)] = (count[key(row)] ?? 0) + 1;
  return Object.freeze(count);
}
