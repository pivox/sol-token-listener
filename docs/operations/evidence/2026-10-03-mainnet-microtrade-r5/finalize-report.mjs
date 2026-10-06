import fs from 'node:fs';
import path from 'node:path';
const project = '/Users/haythem.mabrouk/workspace/perso/sol-token-listener';
const dir = path.join(project, 'docs/operations/evidence/2026-10-03-mainnet-microtrade-r5');
const out = path.join(project, 'docs/operations/mainnet-microtrade-2026-10-03-relance-5-detail.md');
const read = file => { try { return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(x => JSON.parse(x)); } catch { return []; } };
const wait = ms => new Promise(r => setTimeout(r, ms));
const after = Date.parse(process.env.FINAL_AFTER ?? '1970-01-01T00:00:00Z');
while (!read(path.join(dir, 'session.jsonl')).some(x => (x.event === 'session_finished' || x.event === 'fatal') && Date.parse(x.at) > after)) await wait(30000);
const state = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
const events = read(path.join(dir, 'session.jsonl'));
const waves = [];
for (let n = 1; n <= state.waves; n++) {
  const name = `wave-${String(n).padStart(3, '0')}`;
  const folder = path.join(dir, name);
  const sniff = read(path.join(folder, 'sniff.jsonl'));
  const candidates = read(path.join(folder, 'candidates.jsonl'));
  const selection = read(path.join(folder, 'selection.jsonl')).find(x => x.event === 'selection');
  const activity = read(path.join(folder, 'activity.jsonl'));
  waves.push({ name, created: sniff.filter(x => x.event === 'pumpfun_create').length, finalized: candidates.filter(x => x.creationFinalized).length, eligible: selection?.eligible?.length ?? 0, chosen: selection?.chosen ?? null, activityEvents: activity.filter(x => x.event === 'trade').length });
}
const tradeDetails = state.trades.map((trade, i) => {
  const rows = read(path.join(dir, `wave-${String(trade.wave).padStart(3, '0')}`, 'canary.jsonl'));
  const pre = rows.find(x => x.event === 'preflight');
  const sell = rows.filter(x => x.event === 'sell_started').at(-1);
  const quote = rows.filter(x => x.event === 'sell_quote').at(-1);
  const buyTx = rows.find(x => x.event === 'buy_confirmed');
  const sellTx = rows.filter(x => x.event === 'sell_confirmed').at(-1);
  return `| ${i + 1} | \`${trade.mint}\` | ${pre?.expectedBuyLamports ?? '—'} | ${buyTx?.feeLamports ?? '—'} | ${quote?.expectedLamports ?? '—'} | ${sellTx?.feeLamports ?? '—'} | ${trade.trigger === 'net_profit_target' ? `objectif +${trade.targetProfitUsdt ?? '0.01'} USDT net` : trade.trigger === 'three_external_buys_each_above_our_buy' ? `${trade.qualifyingBuys ?? 0}/3 achats > BUY` : trade.trigger === 'three_external_sales_each_above_our_buy' ? `${trade.sales ?? 0}/3 ventes > BUY` : `${trade.buyers}/5 acheteurs`} | ${sell?.reason ?? '—'} | ${trade.pnlUsdt === null ? '—' : trade.pnlUsdt.toFixed(6)} | ${trade.status} |`;
});
const outcome = state.status === 'finished' ? 'Session terminée avec positions déclarées soldées' : `Session arrêtée : ${state.status}`;
const document = `# Bilan détaillé — cinquième relance Mainnet\n\n${outcome}. Début : **${state.startedAt}** ; échéance : **${state.deadlineAt}** ; génération : **${new Date().toISOString()}**.\n\n## Synthèse\n\n- ${state.waves} vagues de découverte, ${state.observed} créations Pump.fun observées, 15 mints au plus par vague.\n- ${state.buys} BUY soumis, ${state.trades.filter(t => t.sellSignature).length} achats exécutés puis revendus, ${state.sells} ventes confirmées, ${state.failed} tentatives échouées.\n- PnL économique estimé, frais des transactions échouées inclus : **${state.estimatedEconomicPnlUsdt.toFixed(6)} USDT**. Solde final : **${(state.walletLamports / 1e9).toFixed(9)} SOL**.\n- Limites : 1 USDT environ en SOL par achat, un trade à la fois, maximum 15 BUY soumis, vente de sécurité après 5 minutes, réserve 0,1 SOL, arrêt si perte cumulée atteint 3 USDT environ.\n\n## Vagues de découverte\n\n| Vague | Créations | Créations finalisées | Candidats éligibles | Événements de trade vus | Choix |\n|---:|---:|---:|---:|---:|---|\n${waves.map((w, i) => `| ${i + 1} | ${w.created} | ${w.finalized} | ${w.eligible} | ${w.activityEvents} | ${w.chosen ? `\`${w.chosen}\`` : 'aucun'} |`).join('\n')}\n\n## Transactions et sorties\n\nLes montants sont en lamports. Le PnL estimé ajoute à la variation de wallet le loyer du compte token conservé avec solde zéro, puis convertit au cours SOL/USDT utilisé pour l'achat.\n\n| # | Mint | Coût prévu BUY | Frais BUY | Produit prévu SELL | Frais SELL | Signal de vente | Motif vente | PnL USDT | État |\n|---:|---|---:|---:|---:|---:|---:|---|---:|---|\n${tradeDetails.join('\n') || '| — | — | — | — | — | — | — | — | — | Aucun achat |'}\n\nLes signatures et le déroulé étape par étape figurent dans le [tableau de session](mainnet-microtrade-2026-10-03-relance-5.md). Les preuves brutes expurgées se trouvent dans [le dossier de la relance](evidence/2026-10-03-mainnet-microtrade-r5/). Les événements de trade ont été reconnus par leur préfixe IDL, puis les signatures d'acheteurs ont été vérifiées finalisées. Le suffixe IDL de 24 octets reste à traiter dans #215. Cette session directe ne valide pas les gates du canary formel #89.\n\nDernière erreur : ${String(state.lastError ?? 'aucune').replaceAll('\n', ' ')}.\n`;
fs.writeFileSync(out, document);
