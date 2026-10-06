import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { failedBuyNeedsRecovery } from './trade-recovery-policy.mjs';

const project = '/Users/haythem.mabrouk/workspace/perso/sol-token-listener';
const dir = path.join(project, 'docs/operations/evidence/2026-10-03-mainnet-microtrade-r5');
const report = path.join(project, 'docs/operations/mainnet-microtrade-2026-10-03-relance-5.md');
const require = createRequire(path.join(project, '.worktrees/unissued-work-inventory/package.json'));
const { Connection, PublicKey } = require('@solana/web3.js');
const { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } = require('@solana/spl-token');
require('dotenv').config({ path: path.join(project, '.env'), quiet: true });
const rpc = new Connection(process.env.SOLANA_HTTP_RPC_URL, { commitment: 'confirmed', wsEndpoint: process.env.SOLANA_WS_RPC_URL });
const wallet = new PublicKey(process.env.EXECUTOR_PUBLIC_KEY);
let started = Date.now();
const durationMinutes = Number(process.env.SESSION_DURATION_MINUTES ?? 30);
if (!Number.isFinite(durationMinutes) || durationMinutes < 17 || durationMinutes > 240) throw Error('SESSION_DURATION_MINUTES must be between 17 and 240');
const durationMs = durationMinutes * 60 * 1000;
let deadline = started + durationMs;
const maxBuys = 15;
const lossLimitUsdt = -3;
const minReserveLamports = 100_000_000;
const stopFile = path.join(dir, 'STOP');
const eventsFile = path.join(dir, 'session.jsonl');
const stateFile = path.join(dir, 'status.json');
const state = { startedAt: new Date(started).toISOString(), deadlineAt: new Date(deadline).toISOString(), status: 'initializing', stage: 'preflight', waves: 0, observed: 0, buys: 0, sells: 0, failed: 0, estimatedEconomicPnlUsdt: 0, walletLamports: null, currentMint: null, currentLog: null, lastError: null, trades: [] };
if (process.env.SESSION_RESUME === '1') {
  const previous = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  started = Date.parse(previous.startedAt);
  deadline = Date.parse(previous.deadlineAt);
  if (!Number.isFinite(started) || !Number.isFinite(deadline) || Date.now() >= deadline) throw Error('Cannot resume expired session');
  Object.assign(state, previous, { status: 'initializing', stage: 'preflight', currentMint: null, currentLog: null, lastError: null });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const readRows = file => { try { return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(x => JSON.parse(x)); } catch { return []; } };
const safe = s => String(s ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ').slice(0, 200);
function emit(event, data = {}) { const row = { at: new Date().toISOString(), event, ...data }; fs.appendFileSync(eventsFile, JSON.stringify(row) + '\n', { mode: 0o600 }); render(); }
function render() {
  const now = new Date().toISOString();
  let live = [];
  if (state.currentLog) live = readRows(state.currentLog);
  const activeWave = state.waves ? path.join(dir, `wave-${String(state.waves).padStart(3, '0')}`) : null;
  const liveObserved = state.stage === 'discovery' && activeWave ? readRows(path.join(activeWave, 'sniff.jsonl')).filter(x => x.event === 'pumpfun_create').length : 0;
  const latest = live.at(-1);
  const livePrice = live.filter(x => x.event === 'price_progress').at(-1);
  const steps = [
    ['Démarrage', state.startedAt, 'Terminé'],
    ['Préflight Mainnet et wallet', state.preflightAt ?? '—', state.preflightAt ? 'Terminé' : 'En cours'],
    ['Découverte Pump.fun', state.waveAt ?? '—', `Vague ${state.waves} ; ${state.observed + liveObserved} créations observées`],
    ['Trade en cours', state.currentMint ?? '—', state.currentMint ? `${safe(latest?.event ?? state.stage)} ; ${livePrice ? `${livePrice.expectedNetProfitLamports}/${livePrice.targetProfitLamports} lamports net` : 'calcul du prix en cours'}` : 'Aucun'],
    ['Arrêt automatique', state.deadlineAt, state.status === 'finished' ? 'Terminé' : 'Prévu'],
  ];
  const resultRows = state.trades.map((t, i) => `| ${i + 1} | \`${t.mint}\` | ${t.buySignature ? `[BUY](https://solscan.io/tx/${t.buySignature})` : '—'} | ${t.sellSignature ? `[SELL](https://solscan.io/tx/${t.sellSignature})` : '—'} | ${t.trigger === 'net_profit_target' ? `objectif +${t.targetProfitUsdt ?? '0.01'} USDT net ; ${t.exitReason ?? 'en cours'}` : t.trigger === 'three_external_buys_each_above_our_buy' ? `${t.qualifyingBuys ?? 0}/3 achats > BUY` : t.trigger === 'three_external_sales_each_above_our_buy' ? `${t.sales ?? 0}/3 ventes > BUY` : `${t.buyers ?? 0}/5 acheteurs`} | ${t.status} | ${t.pnlUsdt === null ? '—' : t.pnlUsdt.toFixed(4)} |`);
  const content = `# Cinquième relance Mainnet — session de trente minutes\n\nMise à jour : **${now}**. Début : **${state.startedAt}**. Fin prévue : **${state.deadlineAt}**. État : **${state.status}**.\n\n## Étapes\n\n| Étape | Heure ou valeur | Résultat |\n|---|---|---|\n${steps.map(x => `| ${x.map(safe).join(' | ')} |`).join('\n')}\n\n## Résultats\n\n| # | Mint | Achat | Vente | Signal de vente | État | PnL estimé USDT |\n|---:|---|---|---|---:|---|---:|\n${resultRows.join('\n') || '| — | — | — | — | — | Aucun trade terminé | — |'}\n\nVagues : **${state.waves}** ; créations observées : **${state.observed}** (15 maximum par vague) ; BUY soumis : **${state.buys}/15** ; ventes : **${state.sells}** ; échecs : **${state.failed}**. PnL économique estimé de cette session : **${state.estimatedEconomicPnlUsdt.toFixed(4)} USDT** ; solde wallet : **${state.walletLamports === null ? '—' : (state.walletLamports / 1e9).toFixed(9) + ' SOL'}**.\n\nLe PnL additionne la variation du wallet et le loyer des comptes token toujours détenus ; sa conversion USDT utilise le cours Kraken de chaque achat. Il reste indicatif jusqu'à la réconciliation finale. Les trades sont directs, hors pipeline API/front existant, et ne valident pas le canary formel #89.\n\nJournaux : [session](evidence/2026-10-03-mainnet-microtrade-r5/session.jsonl), [état JSON](evidence/2026-10-03-mainnet-microtrade-r5/status.json), [preuves par vague et trade](evidence/2026-10-03-mainnet-microtrade-r5/). Arrêt opérateur : créer le fichier \`docs/operations/evidence/2026-10-03-mainnet-microtrade-r5/STOP\` ; une position ouverte est vendue avant l'arrêt si la courbe le permet.\n\nDernier événement : \`${safe(latest?.event ?? state.stage)}\`. Dernière erreur : ${safe(state.lastError ?? 'aucune')}.\n`;
  const tmp = report + '.tmp'; fs.writeFileSync(tmp, content); fs.renameSync(tmp, report);
  const jsonTmp = stateFile + '.tmp'; fs.writeFileSync(jsonTmp, JSON.stringify({ ...state, updatedAt: now, lastTradeEvent: latest?.event ?? null }, null, 2), { mode: 0o600 }); fs.renameSync(jsonTmp, stateFile);
}
async function runChild(name, env, log) {
  return await new Promise(resolve => {
    const output = fs.openSync(log, 'a', 0o600);
    const child = spawn(process.execPath, [path.join(dir, name)], { cwd: project, env: { ...process.env, ...env }, stdio: ['ignore', output, output] });
    emit('child_started', { script: name, pid: child.pid, log: path.basename(log) });
    child.on('error', e => { fs.closeSync(output); resolve({ code: -1, error: String(e) }); });
    child.on('exit', (code, signal) => { fs.closeSync(output); resolve({ code, signal }); });
  });
}
async function walletBalance() { state.walletLamports = await rpc.getBalance(wallet, 'confirmed'); return state.walletLamports; }
async function reconcile(mint, rows) {
  const address = getAssociatedTokenAddressSync(new PublicKey(mint), wallet, false, TOKEN_2022_PROGRAM_ID);
  const account = await rpc.getAccountInfo(address, 'confirmed');
  if (!account) return { tokenRaw: null, rentLamports: 0 };
  const tokenRaw = BigInt('0x' + Buffer.from(account.data.subarray(64, 72)).reverse().toString('hex'));
  return { tokenRaw: String(tokenRaw), rentLamports: account.lamports };
}
async function main() {
  process.on('SIGTERM', () => { fs.writeFileSync(stopFile, 'SIGTERM\n', { mode: 0o600 }); });
  process.on('SIGINT', () => { fs.writeFileSync(stopFile, 'SIGINT\n', { mode: 0o600 }); });
  render();
  const genesis = await rpc.getGenesisHash();
  if (process.env.SOLANA_CLUSTER !== 'mainnet-beta' || genesis !== '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d') throw Error('Mainnet preflight failed');
  await walletBalance();
  if (state.walletLamports < minReserveLamports + 20_000_000) throw Error('Wallet below session reserve');
  state.preflightAt = new Date().toISOString(); state.status = 'running'; emit('preflight_ok', { walletLamports: state.walletLamports });
  if (process.env.SESSION_RESUME === '1') emit('resume_started', { originalDeadlineAt: state.deadlineAt, buysSubmitted: state.buys, sells: state.sells });
  while (Date.now() < deadline - 16 * 60_000 && state.buys < maxBuys && !fs.existsSync(stopFile)) {
    await walletBalance();
    if (state.walletLamports < minReserveLamports + 20_000_000 || state.estimatedEconomicPnlUsdt <= lossLimitUsdt) { state.status = 'risk_stop'; emit('risk_stop', { walletLamports: state.walletLamports, estimatedEconomicPnlUsdt: state.estimatedEconomicPnlUsdt }); break; }
    state.waves++; state.waveAt = new Date().toISOString(); state.stage = 'discovery';
    const waveDir = path.join(dir, `wave-${String(state.waves).padStart(3, '0')}`); fs.mkdirSync(waveDir, { recursive: true, mode: 0o700 });
    emit('wave_started', { wave: state.waves });
    const discovery = await runChild('discover.mjs', { DISCOVER_OUTDIR: waveDir }, path.join(waveDir, 'runner.log'));
    const created = readRows(path.join(waveDir, 'sniff.jsonl')).filter(x => x.event === 'pumpfun_create');
    state.observed += created.length;
    const selection = readRows(path.join(waveDir, 'selection.jsonl')).find(x => x.event === 'selection');
    emit('wave_complete', { wave: state.waves, observed: created.length, chosen: selection?.chosen ?? null, code: discovery.code });
    if (discovery.code !== 0) { state.failed++; state.lastError = `Découverte vague ${state.waves}, code ${discovery.code}`; emit('discovery_error'); await sleep(15000); continue; }
    const mint = selection?.chosen;
    if (!mint || fs.existsSync(stopFile) || Date.now() >= deadline - 16 * 60_000) { await sleep(5000); continue; }
    const tradeLog = path.join(waveDir, 'canary.jsonl');
    state.currentMint = mint; state.currentLog = tradeLog; state.stage = 'trade';
    const trade = { mint, wave: state.waves, buySignature: null, sellSignature: null, buyers: 0, qualifyingBuys: 0, trigger: 'net_profit_target', targetProfitUsdt: process.env.CANARY_MIN_NET_PROFIT_USDT ?? '0.01', exitReason: null, status: 'en cours', pnlUsdt: null };
    state.trades.push(trade); emit('trade_started', { mint, wave: state.waves });
    const result = await runChild('canary.mjs', { CANARY_MINT: mint, CANARY_LOG_PATH: tradeLog, CANARY_STOP_FILE: stopFile }, path.join(waveDir, 'canary-runner.log'));
    let rows = readRows(tradeLog);
    const buy = rows.find(x => x.event === 'buy_submitted');
    if (buy) { state.buys++; trade.buySignature = buy.signature; }
    let sell = rows.filter(x => x.event === 'sell_confirmed').at(-1);
    if (sell) { state.sells++; trade.sellSignature = sell.signature; }
    trade.buyers = rows.filter(x => x.event === 'external_buyer_finalized').length;
    trade.qualifyingBuys = rows.filter(x => x.event === 'external_buy_finalized').length;
    trade.exitReason = rows.filter(x => x.event === 'sell_started').at(-1)?.reason ?? null;
    const complete = rows.find(x => x.event === 'complete');
    let failedOnchain = false;
    if (!complete && buy) {
      let status = null;
      for (let poll = 0; poll < 10; poll++) {
        [status] = (await rpc.getSignatureStatuses([buy.signature], { searchTransactionHistory: true })).value;
        if (status?.confirmationStatus === 'finalized') break;
        await sleep(2000);
      }
      const address = getAssociatedTokenAddressSync(new PublicKey(mint), wallet, false, TOKEN_2022_PROGRAM_ID);
      const tokenAccount = await rpc.getAccountInfo(address, 'confirmed');
      if (!failedBuyNeedsRecovery(status, !!tokenAccount)) {
        failedOnchain = true;
        trade.status = 'BUY rejeté sur chaîne, aucun token reçu';
        state.failed++;
        const tx = await rpc.getTransaction(buy.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
        const price = rows.find(x => x.event === 'preflight')?.krakenSolUsdt;
        if (tx?.meta?.fee && Number.isFinite(price)) {
          trade.pnlUsdt = -tx.meta.fee / 1e9 * price;
          state.estimatedEconomicPnlUsdt += trade.pnlUsdt;
        }
        emit('buy_failed_finalized', { mint, signature: buy.signature, error: status.err, feeLamports: tx?.meta?.fee ?? null });
      } else {
        emit('trade_recovery_started', { mint, code: result.code });
        await sleep(10000);
        const recovery = await runChild('canary.mjs', { CANARY_MINT: mint, CANARY_LOG_PATH: tradeLog, CANARY_RECOVER_SELL: '1' }, path.join(waveDir, 'recovery-runner.log'));
        rows = readRows(tradeLog); sell = rows.filter(x => x.event === 'sell_confirmed').at(-1);
        if (sell && !trade.sellSignature) { state.sells++; trade.sellSignature = sell.signature; }
        if (recovery.code !== 0) { state.status = 'open_position_or_uncertain'; state.lastError = `Récupération impossible pour ${mint}`; trade.status = 'vérification manuelle requise'; emit('recovery_failed', { mint }); break; }
      }
    }
    if (buy && !failedOnchain) {
      const position = await reconcile(mint, rows);
      if (position.tokenRaw !== '0') { state.status = 'open_position_or_uncertain'; state.lastError = `Solde token non nul ou inconnu pour ${mint}`; trade.status = 'position incertaine'; emit('position_uncertain', { mint, tokenRaw: position.tokenRaw }); break; }
      const first = rows.find(x => x.event === 'preflight');
      const finalWallet = await walletBalance();
      if (first && Number.isFinite(first.krakenSolUsdt)) {
        const pnlLamports = finalWallet - first.initialWalletLamports + position.rentLamports;
        trade.pnlUsdt = pnlLamports / 1e9 * first.krakenSolUsdt;
        state.estimatedEconomicPnlUsdt += trade.pnlUsdt;
      }
      trade.status = trade.sellSignature ? 'vendu, solde token 0' : 'solde 0, vente à vérifier';
    } else if (!buy) { trade.status = 'achat non soumis'; }
    if (result.code !== 0 && !failedOnchain) { state.failed++; state.lastError = `Trade ${mint}, code ${result.code}`; }
    state.currentMint = null; state.currentLog = null; state.stage = 'observing';
    emit('trade_complete', { mint, status: trade.status, pnlUsdt: trade.pnlUsdt });
    await sleep(5000);
  }
  await walletBalance();
  if (state.status === 'running') state.status = fs.existsSync(stopFile) ? 'operator_stop' : Date.now() >= deadline - 16 * 60_000 ? 'deadline_no_new_buy' : 'buy_limit';
  state.stage = 'cooldown'; emit('no_new_buy', { status: state.status });
  while (Date.now() < deadline && !fs.existsSync(stopFile)) { await sleep(Math.min(30000, deadline - Date.now())); await walletBalance(); render(); }
  if (state.status !== 'open_position_or_uncertain') state.status = 'finished';
  state.stage = 'done'; emit('session_finished', { walletLamports: state.walletLamports });
}
const refresh = setInterval(() => { try { render(); } catch {} }, 5000);
refresh.unref();
try { await main(); } catch (error) { state.status = 'fatal'; state.lastError = String(error.message ?? error).slice(0, 200); emit('fatal', { message: state.lastError }); process.exitCode = 1; }
finally { clearInterval(refresh); }
