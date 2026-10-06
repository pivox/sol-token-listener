import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const evidence = path.resolve(here, '../../evidence/2026-10-04-mainnet-microtrade-r8');
const lamportsPerSol = 1_000_000_000n;

export function parseJsonLines(text) {
  return text.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

export function reconcileTrade({ buyBefore, buyAfter, rent, sellBefore, sellAfter, buyFee, sellFee, quote }) {
  const values = [buyBefore, buyAfter, rent, sellBefore, sellAfter, buyFee, sellFee, quote].map(BigInt);
  const [before, after, accountRent, sellPre, sellPost, buyNetworkFee, sellNetworkFee, quotedSell] = values;
  const buyCostExRent = before - after - accountRent;
  const sellWalletDelta = sellPost - sellPre;
  const pnlWithRentRecoverable = sellWalletDelta - buyCostExRent;
  return {
    buyCostExRent,
    sellWalletDelta,
    pnlWithRentRecoverable,
    totalNetworkFees: buyNetworkFee + sellNetworkFee,
    sellProceedsInferred: sellWalletDelta + sellNetworkFee,
    quoteGapInferred: sellWalletDelta + sellNetworkFee - quotedSell,
  };
}

function read(file) { return parseJsonLines(fs.readFileSync(file, 'utf8')); }
function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
function writeCsv(file, rows) {
  const columns = Object.keys(rows[0] ?? {});
  fs.writeFileSync(file, `${columns.join(',')}\n${rows.map((row) => columns.map((key) => csvCell(row[key])).join(',')).join('\n')}\n`);
}

export function buildReport() {
  const trades = [];
  const trajectory = [];
  const timeoutScenarios = [];
  const waves = [];
  const candidateRows = [];
  const discoveredMints = new Set();
  let observed = 0;
  let finalized = 0;
  let evaluated = 0;
  let eligible = 0;
  let chosen = 0;
  let discoveryErrors = 0;
  let missingActivityWaves = 0;

  for (let wave = 1; wave <= 9; wave += 1) {
    const dir = path.join(evidence, `wave-${String(wave).padStart(3, '0')}`);
    const candidatesFile = path.join(dir, 'candidates.jsonl');
    const sniffFile = path.join(dir, 'sniff.jsonl');
    const activityFile = path.join(dir, 'activity.jsonl');
    const selectionFile = path.join(dir, 'selection.jsonl');
    const sessionRows = read(path.join(evidence, 'session.jsonl'));
    const waveComplete = sessionRows.find((x) => x.event === 'wave_complete' && x.wave === wave);
    const candidates = fs.existsSync(candidatesFile) ? read(candidatesFile).filter((x) => x.event === 'candidate') : [];
    const creates = fs.existsSync(sniffFile) ? read(sniffFile).filter((x) => x.event === 'pumpfun_create') : [];
    const activity = fs.existsSync(activityFile) ? read(activityFile) : [];
    const activityDone = activity.findLast((x) => x.event === 'activity_stopped');
    const selection = fs.existsSync(selectionFile) ? read(selectionFile).find((x) => x.event === 'selection') : null;
    const rechecks = fs.existsSync(path.join(dir, 'candidate-rechecks.jsonl')) ? read(path.join(dir, 'candidate-rechecks.jsonl')) : [];
    const chosenMint = selection?.chosen ?? null;

    for (const row of creates) discoveredMints.add(row.mint);
    observed += creates.length;
    finalized += candidates.filter((x) => x.creationFinalized === true).length;
    evaluated += activityDone ? candidates.length : 0;
    eligible += selection?.eligible?.length ?? 0;
    if (chosenMint) chosen += 1;
    if (waveComplete && waveComplete.code !== 0) discoveryErrors += 1;
    if (!activityDone) missingActivityWaves += 1;
    waves.push({ wave, observed: creates.length, candidates: candidates.length, finalized: candidates.filter((x) => x.creationFinalized === true).length, activityEvents: activity.filter((x) => x.event === 'trade').length, eligible: selection?.eligible?.length ?? null, chosenMint, discoveryCode: waveComplete?.code ?? 'unknown', activityComplete: Boolean(activityDone) });

    const chosenEligibleMints = new Set((selection?.eligible ?? []).map((x) => x.mint));
    for (const row of candidates) {
      const counts = activityDone?.summary?.[row.mint];
      let reason = 'eligible_but_ranked_below_selected';
      if (!activityDone) reason = 'activity_window_incomplete_no_selection';
      else if (row.error) reason = 'candidate_rpc_or_decode_error';
      else if (!row.creationFinalized) reason = 'creation_not_finalized';
      else if (row.mintOwner !== 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb') reason = 'mint_owner_not_token_2022';
      else if (row.quoteMint !== '11111111111111111111111111111111') reason = 'quote_asset_not_native_sol';
      else if (row.mayhem) reason = 'mayhem_mode';
      else if (row.complete) reason = 'curve_complete';
      else if ((counts?.uniqueBuyers ?? 0) < 3) reason = 'fewer_than_3_unique_buy_wallets_in_45s';
      else if (BigInt(row.realQuoteLamports) < 2_000_000_000n) reason = 'real_quote_reserve_below_2_sol';
      else if (BigInt(row.realQuoteLamports) >= 20_000_000_000n) reason = 'real_quote_reserve_at_least_20_sol';
      else if (BigInt(row.realTokenRaw) <= 300_000_000_000_000n) reason = 'real_token_reserve_not_above_300e12';
      else {
        const recheck = rechecks.find((x) => x.mint === row.mint);
        if (recheck && !recheck.eligible) reason = recheck.error ? 'fresh_recheck_error' : 'fresh_recheck_not_eligible';
        else if (chosenEligibleMints.has(row.mint) && row.mint === chosenMint) reason = 'selected_and_buy_submitted';
      }
      candidateRows.push({ wave, mint: row.mint, creationSignature: creates.find((x) => x.mint === row.mint)?.signature ?? '', creationSlot: creates.find((x) => x.mint === row.mint)?.slot ?? '', activityWindowComplete: Boolean(activityDone), uniqueBuyWallets: counts?.uniqueBuyers ?? '', buyEvents: counts?.buys ?? '', sellEvents: counts?.sells ?? '', mintOwner: row.mintOwner ?? '', quoteMint: row.quoteMint ?? '', mayhem: row.mayhem ?? '', curveComplete: row.complete ?? '', realQuoteLamportsAtCandidateRead: row.realQuoteLamports ?? '', realTokenRawAtCandidateRead: row.realTokenRaw ?? '', recheckEligible: rechecks.find((x) => x.mint === row.mint)?.eligible ?? '', selected: row.mint === chosenMint, reason });
    }

    const canaryPath = path.join(dir, 'canary-runner.log');
    if (!fs.existsSync(canaryPath)) continue;
    const rows = read(canaryPath);
    const get = (event) => rows.find((x) => x.event === event);
    const preflight = get('preflight');
    const buySubmitted = get('buy_submitted');
    const buy = get('buy_confirmed');
    const opened = get('position_open');
    const sold = get('sell_confirmed');
    const sellSubmitted = get('sell_submitted');
    const sellQuote = get('sell_quote');
    if (!preflight || !buy || !opened || !sold || !sellQuote) continue;

    const reconciled = reconcileTrade({
      buyBefore: buy.walletBalanceBeforeLamports,
      buyAfter: buy.walletBalanceAfterLamports,
      rent: opened.tokenAccountRentLamports,
      sellBefore: sold.walletBalanceBeforeLamports,
      sellAfter: sold.walletBalanceAfterLamports,
      buyFee: buy.feeLamports,
      sellFee: sold.feeLamports,
      quote: sellQuote.expectedLamports,
    });
    const price = Number(preflight.krakenSolUsdt);
    const pnlUsdt = Number(reconciled.pnlWithRentRecoverable) / Number(lamportsPerSol) * price;
    const progress = rows.filter((x) => x.event === 'price_progress' && x.expectedNetProfitLamports !== undefined);
    const discoveryLog = fs.existsSync(path.join(dir, 'sniff.jsonl')) ? read(path.join(dir, 'sniff.jsonl')) : [];
    const candidateRead = fs.existsSync(candidatesFile) ? read(candidatesFile).find((x) => x.event === 'candidate' && x.mint === preflight.mint) : null;
    const selectionRead = selection?.at ?? null;
    const extrema = (which) => progress.reduce((best, item) => {
      if (!best) return item;
      const left = BigInt(item.expectedNetProfitLamports);
      const right = BigInt(best.expectedNetProfitLamports);
      return (which === 'min' ? left < right : left > right) ? item : best;
    }, null);
    const min = extrema('min');
    const max = extrema('max');
    const targetReached = rows.some((x) => x.event === 'profit_target_reached');
    const exit = rows.find((x) => x.event === 'sell_started')?.reason ?? 'unknown';
    const t0 = progress[0];
    const mark = {};
    for (const seconds of [0, 5, 10, 20, 30, 60, 120, 300]) {
      const point = seconds === 0 ? t0 : progress.find((x) => x.elapsedSeconds >= seconds);
      const value = point?.expectedNetProfitLamports;
      mark[`t${seconds}`] = value === undefined ? null : `${point.elapsedSeconds}:${value}`;
      if (point) trajectory.push({ wave, mint: preflight.mint, requestedSeconds: seconds, observedElapsedSeconds: point.elapsedSeconds, estimatedNetPnlLamports: value, estimatedNetPnlUsdtAtEntryRate: Number(value) / Number(lamportsPerSol) * price, quoteLamports: point.expectedSellQuoteLamports, source: 'price_progress log; sell quote estimate, not execution' });
    }

    const actualNet = Number(reconciled.pnlWithRentRecoverable);
    const classification = actualNet > 0 && targetReached ? 'C — seuil atteint, déclenchement et vente confirmés' : max && BigInt(max.expectedNetProfitLamports) < 0n ? 'A — aucune fenêtre positive observée' : 'E — données insuffisantes';
    trades.push({
      wave, mint: preflight.mint, buySignature: buy.signature, sellSignature: sold.signature,
      createDetectedLocalAt: discoveryLog.find((x) => x.event === 'pumpfun_create' && x.mint === preflight.mint)?.at ?? '',
      candidateReadLocalAt: candidateRead?.at ?? '', selectionLocalAt: selectionRead ?? '', buyPreflightLocalAt: preflight.at,
      buySubmittedLocalAt: buySubmitted?.at ?? '', buyConfirmedLocalAt: buy.at, sellSubmittedLocalAt: sellSubmitted?.at ?? '', sellConfirmedLocalAt: sold.at,
      buySlot: buy.slot, sellSlot: sold.slot, buyTokensRaw: opened.tokenRaw,
      buyEventLamports: buy.actualTradeSolLamports, buyEconomicCostExRentLamports: String(reconciled.buyCostExRent),
      rentStillInAtaLamports: opened.tokenAccountRentLamports, sellQuoteLamports: sellQuote.expectedLamports,
      sellWalletDeltaLamports: String(reconciled.sellWalletDelta), sellActualProceedsInferredLamports: String(reconciled.sellProceedsInferred),
      sellQuoteGapInferredLamports: String(reconciled.quoteGapInferred), buyMetaFeeLamports: buy.feeLamports,
      sellMetaFeeLamports: sold.feeLamports, totalMetaFeesLamports: String(reconciled.totalNetworkFees),
      entryKrakenSolUsdt: price, realizedEconomicPnlLamports: String(reconciled.pnlWithRentRecoverable),
      estimatedPnlUsdt: pnlUsdt, targetUsdt: preflight.targetProfitUsdt, targetReached, exitReason: exit,
      firstValidSnapshot: t0 ? `${t0.elapsedSeconds}s/${t0.expectedNetProfitLamports} lamports` : 'missing',
      minimumObserved: min ? `${min.elapsedSeconds}s/${min.expectedNetProfitLamports} lamports` : 'missing',
      maximumObserved: max ? `${max.elapsedSeconds}s/${max.expectedNetProfitLamports} lamports` : 'missing',
      t0: mark.t0, t5: mark.t5, t10: mark.t10, t20: mark.t20, t30: mark.t30, t60: mark.t60, t120: mark.t120, t300: mark.t300,
      classification,
    });

    for (const timeoutSeconds of [30, 60, 120, 300]) {
      if (timeoutSeconds === 300) {
        timeoutScenarios.push({ wave, mint: preflight.mint, timeoutSeconds, basis: 'observed baseline execution', sampleSeconds: '', estimatedPnlLamports: String(reconciled.pnlWithRentRecoverable), estimatedPnlUsdt: pnlUsdt, assumption: 'confirmed wallet balance deltas plus recoverable rent; actual transaction timing' });
      } else if (targetReached && (rows.find((x) => x.event === 'profit_target_reached')?.at ?? '') < (rows.find((x) => x.event === 'sell_confirmed')?.at ?? '') && (rows.find((x) => x.event === 'sell_started')?.reason === 'net_profit_target')) {
        timeoutScenarios.push({ wave, mint: preflight.mint, timeoutSeconds, basis: 'observed profit exit before timeout', sampleSeconds: '', estimatedPnlLamports: String(reconciled.pnlWithRentRecoverable), estimatedPnlUsdt: pnlUsdt, assumption: 'actual profit triggered sale before this timeout; unchanged for longer timeout' });
      } else {
        const point = progress.find((x) => x.elapsedSeconds >= timeoutSeconds);
        timeoutScenarios.push(point ? {
          wave, mint: preflight.mint, timeoutSeconds, basis: 'snapshot-only counterfactual', sampleSeconds: point.elapsedSeconds,
          estimatedPnlLamports: String(BigInt(point.expectedNetProfitLamports) + 5000n),
          estimatedPnlUsdt: Number(BigInt(point.expectedNetProfitLamports) + 5000n) / Number(lamportsPerSol) * price,
          assumption: 'quote observed while actual position remained open; replaces 50,000-lamport reserve with observed 45,000-lamport fee; ignores sale latency and own market impact',
        } : { wave, mint: preflight.mint, timeoutSeconds, basis: 'no eligible snapshot', sampleSeconds: '', estimatedPnlLamports: '', estimatedPnlUsdt: '', assumption: 'position had already closed or no snapshot exists at/after requested time' });
      }
    }
  }

  const sum = trades.reduce((acc, row) => acc + BigInt(row.realizedEconomicPnlLamports), 0n);
  const totalRent = trades.reduce((acc, row) => acc + BigInt(row.rentStillInAtaLamports), 0n);
  const feeTotal = trades.reduce((acc, row) => acc + BigInt(row.totalMetaFeesLamports), 0n);
  const firstCanary = read(path.join(evidence, 'wave-001/canary-runner.log')).find((x) => x.event === 'preflight');
  const sessionStatus = JSON.parse(fs.readFileSync(path.join(evidence, 'status.json'), 'utf8'));
  const walletDelta = BigInt(sessionStatus.walletLamports) - BigInt(firstCanary.initialWalletLamports);
  const nativePnlFromCashPlusRent = walletDelta + totalRent;
  const converted = trades.reduce((acc, row) => acc + Number(row.estimatedPnlUsdt), 0);
  return {
    trades, trajectory, timeoutScenarios, waves, candidateRows,
    summary: {
      observedMints: observed, uniqueMintsAcrossWaves: discoveredMints.size, duplicateObservations: observed - discoveredMints.size,
      candidateMetadataRows: candidateRows.length, candidatesEvaluatedWithCompleteActivity: evaluated, finalizedCandidates: finalized, fullyObservedActivityWaves: 8,
      eligibleFromFinalSelectionSnapshots: eligible, buysConfirmed: trades.length, sellsConfirmed: trades.length,
      discoveryErrors, wavesWithIncompleteActivity: missingActivityWaves,
      walletStartLamports: firstCanary.initialWalletLamports, walletEndLamports: sessionStatus.walletLamports,
      walletCashDeltaLamports: String(walletDelta), emptyTokenAccountRentLamports: String(totalRent),
      economicPnlLamports: String(sum), pnlViaCashPlusRentLamports: String(nativePnlFromCashPlusRent),
      differenceReconciliationLamports: String(sum - nativePnlFromCashPlusRent),
      totalNetworkFeesFromConfirmedMetaLamports: String(feeTotal),
      entryRateConvertedUsdt: converted, reportedStatusUsdt: sessionStatus.estimatedEconomicPnlUsdt,
      buyFeeCount: trades.length, sellFeeCount: trades.length,
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = buildReport();
  writeCsv(path.join(here, 'trades-r8.csv'), report.trades);
  writeCsv(path.join(here, 'trajectories-r8.csv'), report.trajectory);
  writeCsv(path.join(here, 'timeout-snapshot-r8.csv'), report.timeoutScenarios);
  writeCsv(path.join(here, 'selection-funnel-r8.csv'), report.candidateRows);
  fs.writeFileSync(path.join(here, 'reconciliation-r8.json'), `${JSON.stringify(report.summary, null, 2)}\n`);
  console.log(JSON.stringify(report.summary, null, 2));
}
