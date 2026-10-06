import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildLiveSessionReconciliation } from '../src/telemetry/live-session-reconciliation.js';

const { values } = parseArgs({ options: {
  source: { type: 'string' }, transactions: { type: 'string' }, wallet: { type: 'string' },
  session: { type: 'string' }, out: { type: 'string' },
} });

export async function writeLiveSessionEvidenceReport(input: {
  readonly sourceDirectory: string;
  readonly transactionsFile: string;
  readonly wallet: string;
  readonly sessionId: string;
  readonly outputDirectory: string;
}): Promise<Readonly<Record<string, unknown>>> {
  const source = path.resolve(input.sourceDirectory);
  const transactionsFile = path.resolve(input.transactionsFile);
  const output = path.resolve(input.outputDirectory);
  try { await access(output); throw new Error('OUTPUT_DIRECTORY_ALREADY_EXISTS'); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  const readRows = async (file: string): Promise<Record<string, unknown>[]> => {
    const text = await readFile(file, 'utf8');
    return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).flatMap((line) => {
      try { const value: unknown = JSON.parse(line); return isRecord(value) ? [value] : []; }
      catch { return []; }
    });
  };
  const [sourceRows, signatureRows, attempts] = await Promise.all([
    readRows(path.join(source, 'session.jsonl')),
    readRows(path.join(path.dirname(transactionsFile), 'signature-index.v1.jsonl')),
    readRows(transactionsFile),
  ]);
  const report = buildLiveSessionReconciliation({ sessionId: input.sessionId, wallet: input.wallet,
    sessionRows: sourceRows, signatureIndex: signatureRows.filter((row) => row.kind === 'signature_index'),
    rpcAttempts: attempts.filter((row) => row.kind === 'rpc_attempt') });
  await mkdir(output, { recursive: false, mode: 0o700 });
  await writeFile(path.join(output, 'session-reconciliation.v1.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await writeFile(path.join(output, 'session-reconciliation.md'), renderMarkdown(report), { mode: 0o600, flag: 'wx' });
  return report;
}

function renderMarkdown(report: Readonly<Record<string, unknown>>): string {
  const rpc = asObject(report.rpc);
  const cash = asObject(report.cashAndFees);
  const funding = asObject(report.accountFundingAndRefunds);
  const positions = Array.isArray(report.positions) ? report.positions.map(asObject) : [];
  const attempts = Array.isArray(report.orderAttempts) ? report.orderAttempts.map(asObject) : [];
  const accountEvents = Array.isArray(funding.transactionLifecycleEvents) ? funding.transactionLifecycleEvents.map(asObject) : [];
  return [
    '# Rapprochement d’une session live par signature', '',
    `Session : ${String(report.sessionId)} ; wallet : ${String(report.wallet)}.`,
    `Ordres/tentatives exportés : ${attempts.length}. Signatures indexées : ${String(rpc.indexedSignatures ?? 0)} ; métadonnées exploitables : ${String(rpc.transactionsWithUsableMetadata ?? 0)}.`, '',
    '| Mesure | Valeur |', '|---|---|',
    `| Δ lamports wallet des signatures récupérées | ${String(cash.collectedWalletLamportDeltaRaw ?? 'INCONNU')} |`,
    `| Frais réseau observés | ${String(cash.observedNetworkFeesRaw ?? 'INCONNU')} ; déjà inclus dans les deltas wallet |`,
    `| Δ tokens wSOL | ${String(cash.wrappedSolTokenDeltaRaw ?? 'INCONNU')} (rapporté séparément) |`,
    '| Variation de trésorerie session | INCONNUE : soldes aux bornes absents |',
    '| Résultat économique net | NON CALCULABLE avec les preuves exportées |', '',
    'Les signatures inconnues, réponses RPC nulles, frais absents et quantités absentes restent inconnus. Les frais réseau déjà reflétés dans le solde wallet ne sont pas soustraits une seconde fois. Un mouvement wSOL reste distinct du delta lamports. Les soldes historiques de comptes ne sont pas remplacés par leur état actuel.', '',
    '## Positions suivies', '',
    '| Position | Mint | Acquise par ordres confirmés | Vendue par ordres confirmés | Reliquat attribué | Statut quantité |',
    '|---|---|---:|---:|---:|---|',
    ...positions.map((row) => `| ${String(row.positionId ?? '')} | ${String(row.mint ?? 'INCONNU')} | ${String(row.acquiredFromConfirmedSignaturesRaw ?? 'INCONNU')} | ${String(row.soldFromConfirmedSignaturesRaw ?? 'INCONNU')} | ${String(row.remainingFromOrderDeltasRaw ?? 'INCONNU')} | ${String(row.quantityStatus ?? 'INCONNU')} |`), '',
    '## Tentatives', '',
    '| Ordre | Position | Côté | Statut durable | Signature |', '|---|---|---|---|---|',
    ...attempts.map((row) => `| ${String(row.orderId ?? '')} | ${String(row.positionId ?? '')} | ${String(row.side ?? '')} | ${String(row.status ?? '')} | ${String(row.signature ?? 'ABSENTE')} |`), '',
    '## Fonds récupérables et remboursements observés', '',
    '| Signature | Compte | État | Début | Fin | Δ compte | Destination fermeture | Δ destination observé | Remboursement candidat |',
    '|---|---|---|---:|---:|---:|---|---:|---:|',
    ...(accountEvents.length === 0 ? ['| — | — | NON OBSERVÉ | INCONNU | INCONNU | INCONNU | INCONNUE | INCONNU | INCONNU |']
      : accountEvents.map((row) => `| ${String(row.signature ?? '')} | ${String(row.address ?? '')} | ${String(row.classification ?? '')} | ${String(row.startLamportsRaw ?? 'INCONNU')} | ${String(row.endLamportsRaw ?? 'INCONNU')} | ${String(row.balanceDeltaRaw ?? 'INCONNU')} | ${String(row.refundDestination ?? 'INCONNUE')} | ${String(row.refundDestinationLamportDeltaRaw ?? 'INCONNU')} | ${String(row.refundCandidateRaw ?? 'INCONNU')} |`)), '',
    `État historique en fin de session : ${String(funding.historicalSessionEndBalances ?? 'INCONNU')}. Δ destination est le changement net du compte destinataire dans cette même transaction; il n’est assimilé au remboursement que si les preuves de fermeture et les deltas concordent.`, '',
  ].join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function asObject(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {}; }

if (process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const { source, transactions, wallet, session, out } = values;
  if (!source || !transactions || !wallet || !session || !out) {
    process.stderr.write('Usage: npm run live:evidence:report -- --source SESSION_DIR --transactions CACHE/transactions.v1.jsonl --wallet PUBKEY --session ID --out NEW_DIR\n');
    process.exitCode = 2;
  } else {
    void writeLiveSessionEvidenceReport({ sourceDirectory: source, transactionsFile: transactions,
      wallet, sessionId: session, outputDirectory: out }).then((report) => {
      process.stdout.write(`${JSON.stringify({ event: 'live_session_reconciliation_written', sessionId: report.sessionId, completeness: report.completeness })}\n`);
    }).catch((error: unknown) => {
      process.stderr.write(`LIVE_SESSION_REPORT_FAILED: ${error instanceof Error ? error.message : 'unknown error'}\n`);
      process.exitCode = 1;
    });
  }
}
