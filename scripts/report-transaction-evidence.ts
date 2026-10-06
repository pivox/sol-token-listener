import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import { parseJournal } from '../src/telemetry/journal.js';
import { classifyRpcTransaction, reconcileTransaction, type ReconciledTransaction } from '../src/telemetry/transaction-evidence.js';

const { values } = parseArgs({ options: { source: { type: 'string' }, transactions: { type: 'string' }, out: { type: 'string' } } });
if (!values.source || !values.transactions || !values.out) throw new Error('Usage: tsx scripts/report-transaction-evidence.ts --source EVIDENCE_DIR --transactions transactions.v1.jsonl --out NEW_DIR');
const source = path.resolve(values.source); const inputFile = path.resolve(values.transactions); const out = path.resolve(values.out);
try { await access(out); throw new Error('OUTPUT_DIRECTORY_ALREADY_EXISTS'); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }

async function jsonl(file: string): Promise<Record<string, unknown>[]> {
  let text: string; try { text = await readFile(file, 'utf8'); } catch { return []; }
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).flatMap(line => {
    try { const row: unknown = JSON.parse(line); return typeof row === 'object' && row !== null && !Array.isArray(row) ? [row as Record<string, unknown>] : []; }
    catch { return []; }
  });
}
const index = parseJournal(await readFile(path.join(path.dirname(inputFile), 'signature-index.v1.jsonl'), 'utf8'))
  .filter(x => x.kind === 'signature_index');
const cache = parseJournal(await readFile(inputFile, 'utf8')).filter(x => x.kind === 'rpc_attempt');
const firstCanary = await jsonl(path.join(source, 'wave-001/canary.jsonl'));
const wallet = String(firstCanary.find(x => x.event === 'preflight')?.wallet ?? '');
const latest = new Map<string, Record<string, unknown>>();
for (const row of cache) if (typeof row.signature === 'string') latest.set(row.signature, row);
const links = new Map(index.filter(x => typeof x.signature === 'string').map(x => [x.signature as string, x.links]));
const walletTx = new Map<string, ReconciledTransaction>();
const rows: Record<string, unknown>[] = [];
for (const [signature, row] of latest) {
  const classified = classifyRpcTransaction(row.httpResponse);
  const ledger = reconcileTransaction(signature, row.httpResponse, wallet, String(object(row.parameters)?.commitment ?? 'finalized'));
  const collectionStatus = typeof row.status === 'string' ? row.status : classified.status;
  const status = collectionStatus === 'RPC_ERROR' ? 'RPC_ERROR' : ledger.status;
  const reconciled = { ...ledger, status };
  if (reconciled.feePayer === wallet) walletTx.set(signature, reconciled);
  rows.push({ id: `signature:${signature}`, kind: 'transaction_reconciliation', schema: 'transaction_evidence.v1', links: links.get(signature) ?? [],
    collectionStatus, retrievedAt: row.retrievedAt, parameters: row.parameters, ...reconciled,
    rawMetaStatus: row.httpResponse === null && row.transportErrorCategory !== null ? 'NOT_AVAILABLE' : classified.status,
    transportErrorCategory: row.transportErrorCategory ?? null, transportErrorDetail: row.transportErrorDetail ?? null,
    httpStatus: row.httpStatus ?? null, timeoutMs: row.timeoutMs ?? null, retryAfterRaw: row.retryAfterRaw ?? null });
}

const first = firstCanary.find(x => x.event === 'preflight');
const status = JSON.parse(await readFile(path.join(source, 'status.json'), 'utf8')) as Record<string, unknown>;
const start = Number(first?.initialWalletLamports); const end = Number(status.walletLamports);
const cashDelta = Number.isSafeInteger(start) && Number.isSafeInteger(end) ? String(BigInt(end) - BigInt(start)) : null;
const positions: Record<string, unknown>[] = [];
const waves = (await import('node:fs/promises')).readdir(source, { withFileTypes: true });
for (const dir of (await waves).filter(x => x.isDirectory() && /^wave-\d+$/.test(x.name)).sort((a,b) => a.name.localeCompare(b.name))) {
  const wave = Number(dir.name.slice(5)); const canary = await jsonl(path.join(source, dir.name, 'canary.jsonl'));
  const preflight = canary.find(x => x.event === 'preflight'); if (!preflight || typeof preflight.mint !== 'string') continue;
  const buy = canary.find(x => x.event === 'buy_confirmed'); const sell = canary.find(x => x.event === 'sell_confirmed');
  if (!buy || !sell || typeof buy.signature !== 'string' || typeof sell.signature !== 'string') continue;
  const ata = getAssociatedTokenAddressSync(new PublicKey(preflight.mint), new PublicKey(String(preflight.wallet)), false, TOKEN_2022_PROGRAM_ID).toBase58();
  const buyTx = rows.find(x => x.signature === buy.signature) as (ReconciledTransaction & Record<string, unknown>) | undefined;
  const sellTx = rows.find(x => x.signature === sell.signature) as (ReconciledTransaction & Record<string, unknown>) | undefined;
  const buyAccount = buyTx?.accounts.find(x => x.address === ata); const sellAccount = sellTx?.accounts.find(x => x.address === ata);
  const lifecycle = buyTx?.accountLifecycles.find(x => x.address === ata)?.classification ?? 'UNKNOWN';
  const tokenAfter = sellTx?.tokenChanges.find(x => x.account === ata)?.postAmountRaw ?? null;
  positions.push({ wave, mint: preflight.mint, ata, buySignature: buy.signature, sellSignature: sell.signature,
    buyTransactionStatus: buyTx?.status ?? 'NOT_COLLECTED', sellTransactionStatus: sellTx?.status ?? 'NOT_COLLECTED',
    ataLifecycle: lifecycle, startLamportsRaw: buyAccount?.preLamportsRaw ?? null, endLamportsRaw: sellAccount?.postLamportsRaw ?? null,
    lockedBalanceDeltaRaw: buyAccount?.preLamportsRaw !== null && buyAccount?.preLamportsRaw !== undefined && sellAccount?.postLamportsRaw !== null && sellAccount?.postLamportsRaw !== undefined
      ? String(BigInt(sellAccount.postLamportsRaw) - BigInt(buyAccount.preLamportsRaw)) : null,
    residualTokenRaw: tokenAfter, residualValueRaw: tokenAfter === '0' ? '0' : null });
}
const allPositionAmountsKnown = positions.length > 0 && positions.every(x => typeof x.residualTokenRaw === 'string');
const residualPositionValue = allPositionAmountsKnown && positions.every(x => x.residualTokenRaw === '0') ? '0' : null;
const allAtaChangesKnown = positions.length > 0 && positions.every(x => typeof x.lockedBalanceDeltaRaw === 'string');
const lockedDelta = allAtaChangesKnown ? String(positions.reduce((sum, x) => sum + BigInt(x.lockedBalanceDeltaRaw as string), 0n)) : null;
const systemTransferCandidates = rows.flatMap(tx => (tx.transfers as ReconciledTransaction['transfers'] | undefined ?? [])
  .filter(x => x.kind === 'SYSTEM_TRANSFER' && (x.source === wallet || x.destination === wallet))
  .map(x => ({ signature: tx.signature, location: x.location, source: x.source, destination: x.destination, amountRaw: x.amountRaw })));
const selectedSigs = new Set(positions.flatMap(x => [x.buySignature, x.sellSignature] as string[]));
const selectedTx = rows.filter(x => selectedSigs.has(String(x.signature)));
const allTradeTxAvailable = selectedTx.length === positions.length * 2 && selectedTx.every(x => ['RESPONSE_AVAILABLE', 'EXECUTED_WITH_ERROR'].includes(String(x.status)));
const tradeWalletDelta = allTradeTxAvailable ? String(selectedTx.reduce((sum, x) => sum + BigInt(String(x.walletLamportDeltaRaw)), 0n)) : null;
const tradeWalletDeltaVsCashGap = tradeWalletDelta !== null && cashDelta !== null ? String(BigInt(cashDelta) - BigInt(tradeWalletDelta)) : null;
const networkFeesForWalletTx = rows.filter(x => x.feePayer === wallet && x.networkFeeRaw !== null).reduce((sum, x) => sum + BigInt(String(x.networkFeeRaw)), 0n);
const knownWalletTransactions = rows.filter(x => x.feePayer === wallet).length;
const knownWalletFeesComplete = rows.every(x => x.feePayer !== wallet || x.networkFeeRaw !== null);
const report = {
  schema: 'session_transaction_reconciliation.v1', session: '2026-10-04-mainnet-microtrade-r8', wallet,
  rpcResponses: { indexedSignatures: index.length, attemptedSignatures: latest.size,
    usableTransactionMetadata: [...latest.values()].filter(x => ['RESPONSE_AVAILABLE', 'EXECUTED_WITH_ERROR'].includes(String(x.status))).length,
    statuses: Object.fromEntries([...latest.values()].reduce((m, x) => m.set(String(x.status), (m.get(String(x.status)) ?? 0) + 1), new Map<string, number>())) },
  A_walletCash: { startLamportsRaw: Number.isSafeInteger(start) ? String(start) : null, endLamportsRaw: Number.isSafeInteger(end) ? String(end) : null,
    deltaLamportsRaw: cashDelta, chainDeltaForTradeSignaturesRaw: tradeWalletDelta, unexplainedVersusTradeTransactionsLamportsRaw: tradeWalletDeltaVsCashGap },
  B_externalMovements: { identifiedCandidates: systemTransferCandidates, coverage: 'INCOMPLETE', netLamportsRaw: null,
    note: 'Transaction index does not establish complete wallet history or counterparty ownership. Candidates require explicit review.' },
  C_recoverableAccountBalances: { accounts: positions.map(x => ({ mint: x.mint, address: x.ata, lifecycle: x.ataLifecycle,
    startLamportsRaw: x.startLamportsRaw, endLamportsRaw: x.endLamportsRaw, deltaLamportsRaw: x.lockedBalanceDeltaRaw })),
    deltaLamportsRaw: lockedDelta, coverage: allAtaChangesKnown ? 'COMPLETE_FOR_SIX_TRACKED_ATAS' : 'INCOMPLETE' },
  D_residualPositions: { positions: positions.map(x => ({ mint: x.mint, tokenAmountRaw: x.residualTokenRaw, liquidationValueRaw: x.residualValueRaw })),
    liquidationValueRaw: residualPositionValue, coverage: allPositionAmountsKnown ? 'TOKEN_BALANCES_AVAILABLE' : 'INCOMPLETE' },
  E_economicResultLamportsRaw: null,
  E_status: 'INCOMPLETE_WALLET_HISTORY',
  fees: { observedNetworkFeesRaw: String(networkFeesForWalletTx), walletFeePayerTransactions: knownWalletTransactions, feeRowsCompleteForCollectedTransactions: knownWalletFeesComplete,
    alreadyIncludedInWalletBalanceDeltas: true, subtractedAgain: false },
  positions,
};
await mkdir(out, { recursive: true, mode: 0o700 });
const lines = rows.map(x => JSON.stringify(x)).join('\n') + (rows.length ? '\n' : '');
await writeFile(path.join(out, 'signature-ledger.v1.jsonl'), lines, { mode: 0o600, flag: 'wx' });
await writeFile(path.join(out, 'session-reconciliation.v1.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
const md = [
  '# Rapprochement historique par signature', '',
  `Signatures indexées : ${index.length} ; signatures tentées : ${latest.size} ; transactions avec métadonnées exploitables : ${report.rpcResponses.usableTransactionMetadata}.`, '',
  '| Partie | Montant / état |', '|---|---|',
  `| A. Variation de trésorerie | ${cashDelta ?? 'INCONNU'} lamports |`,
  `| A. Somme des deltas chain des BUY/SELL | ${tradeWalletDelta ?? 'INCONNU'} lamports |`,
  `| A. Résidu non rapproché | ${tradeWalletDeltaVsCashGap ?? 'INCONNU'} lamports |`,
  `| B. Flux externes | INCOMPLET; ${systemTransferCandidates.length} candidat(s) à examiner |`,
  `| C. Variation ATA des six positions | ${lockedDelta ?? 'INCONNU'} lamports (${allAtaChangesKnown ? 'couverture six ATA' : 'incomplet'}) |`,
  `| D. Positions résiduelles | ${residualPositionValue ?? 'INCONNU'} en valeur de liquidation |`,
  `| E. Résultat économique | ${report.E_economicResultLamportsRaw ?? 'NON RAPPROCHÉ'} lamports |`, '',
  'Les frais réseau observés sont inclus dans les deltas wallet et ne sont pas soustraits une seconde fois. Les comptes non listés et transferts non présents dans l’index ne sont pas supposés absents.', '',
  '## Positions', '', '| Vague | Mint | ATA | Début | Fin | Δ immobilisé | Token résiduel | État BUY / SELL |', '|---:|---|---|---:|---:|---:|---:|---|',
  ...positions.map(x => `| ${x.wave} | ${x.mint} | ${x.ata} | ${x.startLamportsRaw ?? 'INCONNU'} | ${x.endLamportsRaw ?? 'INCONNU'} | ${x.lockedBalanceDeltaRaw ?? 'INCONNU'} | ${x.residualTokenRaw ?? 'INCONNU'} | ${x.buyTransactionStatus} / ${x.sellTransactionStatus} |`), '',
].join('\n');
await writeFile(path.join(out, 'session-reconciliation.md'), md, { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ event: 'transaction_reconciliation_written', indexedSignatures: index.length, attemptedSignatures: latest.size,
  usableTransactionMetadata: report.rpcResponses.usableTransactionMetadata, outputFiles: 3, economicResultAvailable: report.E_economicResultLamportsRaw !== null }));

function object(value: unknown): Record<string, unknown> | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
