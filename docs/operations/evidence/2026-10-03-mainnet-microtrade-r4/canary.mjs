import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { lamportsForUsdt, requiredSellQuoteLamports, expectedNetProfitLamports, meetsProfitTarget } from './profit-policy.mjs';

const project = '/Users/haythem.mabrouk/workspace/perso/sol-token-listener';
const worktree = path.join(project, '.worktrees/unissued-work-inventory');
const require = createRequire(path.join(worktree, 'package.json'));
const { Connection, PublicKey, Keypair, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, NATIVE_MINT, getAssociatedTokenAddressSync, getAccount, unpackMint, getExtensionTypes, ExtensionType } = require('@solana/spl-token');
const BN = require('bn.js');
const bs58 = require('bs58').default;
const { OnlinePumpSdk, PUMP_SDK, getBuyTokenAmountFromSolAmount, getBuySolAmountFromTokenAmount, getSellSolAmountFromTokenAmount } = require('@pump-fun/pump-sdk');
require('dotenv').config({ path: path.join(project, '.env'), quiet: true });
const { PumpBorshReader } = await import(path.join(worktree, 'dist/src/launchpads/pumpfun/borsh-reader.js'));
const { decodeIdlFields } = await import(path.join(worktree, 'dist/src/launchpads/pumpfun/idl-codec.js'));
const { PUMP_TYPES, PUMP_EVENTS } = await import(path.join(worktree, 'dist/src/launchpads/pumpfun/generated/pump-idl.js'));

const out = process.env.CANARY_LOG_PATH ?? '/tmp/sol-token-listener-microtrade-20261003/canary.jsonl';
const mint = new PublicKey(process.env.CANARY_MINT ?? 'A3KGAmJzLP1Jhup5DSdp2u8crTg5Ma5w4EKbJYFNR4Mo');
const maxHoldMs = 15 * 60 * 1000;
const stopFile = process.env.CANARY_STOP_FILE;
const targetProfitUsdt = process.env.CANARY_MIN_NET_PROFIT_USDT ?? '0.01';
const sellNetworkFeeReserveLamports = 50000n;
const transactionLimit = 5;
const allowedExtensions = new Set([
  ExtensionType.MintCloseAuthority, ExtensionType.MetadataPointer,
  ExtensionType.TokenMetadata, ExtensionType.GroupPointer,
  ExtensionType.TokenGroup, ExtensionType.GroupMemberPointer,
  ExtensionType.TokenGroupMember,
]);
const emit = (event, data = {}) => {
  const record = { at: new Date().toISOString(), event, ...data };
  let line = JSON.stringify(record);
  for (const secret of [process.env.SOLANA_HTTP_RPC_URL, process.env.SOLANA_WS_RPC_URL, rawKey]) {
    if (secret) line = line.replaceAll(secret, '[redacted]');
  }
  const apiKey = new URL(process.env.SOLANA_HTTP_RPC_URL).searchParams.get('api-key');
  if (apiKey) line = line.replaceAll(apiKey, '[redacted]');
  fs.appendFileSync(out, `${line}\n`, { mode: 0o600 });
  console.log(line);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (code, detail) => { throw new Error(`${code}: ${detail}`); };
const toBN = (value) => new BN(String(value));
const toSol = (lamports) => Number(lamports) / LAMPORTS_PER_SOL;
const rawKey = fs.readFileSync(path.join(project, '.key'), 'utf8').trim();
const decodedKey = bs58.decode(rawKey);
if (decodedKey.length !== 64) fail('KEY_FORMAT', 'Expected 64-byte Base58 secret key');
const wallet = Keypair.fromSecretKey(decodedKey);
if (wallet.publicKey.toBase58() !== process.env.EXECUTOR_PUBLIC_KEY) fail('KEY_MISMATCH', 'Key does not match EXECUTOR_PUBLIC_KEY');
if (process.env.SOLANA_CLUSTER !== 'mainnet-beta' || process.env.SOLANA_EXPECTED_GENESIS_HASH !== '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d') fail('CONFIG', 'Mainnet guard failed');
const connection = new Connection(process.env.SOLANA_HTTP_RPC_URL, { commitment: 'confirmed', wsEndpoint: process.env.SOLANA_WS_RPC_URL });
const online = new OnlinePumpSdk(connection);
const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID);
const tradeDiscriminator = Buffer.from(PUMP_EVENTS.TradeEvent.discriminator);
let ownBuySlot = null;
let ownBuySignature = null;
let sentCount = 0;

function parseTrade(line) {
  if (!line.startsWith('Program data: ')) return null;
  let bytes;
  try { bytes = Buffer.from(line.slice(14), 'base64'); } catch { return null; }
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(tradeDiscriminator)) return null;
  try {
    const reader = new PumpBorshReader(bytes.subarray(8));
    const fields = decodeIdlFields(PUMP_TYPES.TradeEvent.type.fields.slice(0, -2), reader);
    return { mint: fields.mint, user: fields.user, isBuy: fields.is_buy, solAmountLamports: String(fields.sol_amount), suffixBytes: reader.remaining };
  } catch { return null; }
}

async function sendSimulated(kind, instructions) {
  if (sentCount >= transactionLimit) fail('TX_LIMIT', 'Transaction attempt cap reached');
  const block = await connection.getLatestBlockhash('confirmed');
  const tx = new VersionedTransaction(new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: block.blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100000 }),
      ...instructions,
    ],
  }).compileToV0Message());
  tx.sign([wallet]);
  const simulation = await connection.simulateTransaction(tx, { sigVerify: true, commitment: 'confirmed' });
  emit(`${kind.toLowerCase()}_simulation`, { err: simulation.value.err, unitsConsumed: simulation.value.unitsConsumed, logsTail: simulation.value.err ? simulation.value.logs?.slice(-12) : undefined });
  if (simulation.value.err) fail('SIMULATION_FAILED', kind);
  if (process.env.CANARY_DRY_RUN === '1') return { dryRun: true };
  const raw = tx.serialize();
  const signature = await connection.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 10 });
  sentCount += 1;
  emit(`${kind.toLowerCase()}_submitted`, { signature });
  let status = null;
  for (let poll = 0; poll < 25; poll++) {
    [status] = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value;
    if (status?.err) fail('TRANSACTION_FAILED', `${kind}: ${signature}: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') break;
    if (await connection.getBlockHeight('confirmed') > block.lastValidBlockHeight) break;
    if (poll > 0 && poll % 2 === 0) {
      try { await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 3 }); }
      catch (error) { emit('rebroadcast_error', { kind, poll, message: String(error.message ?? error) }); }
    }
    await sleep(2000);
  }
  if (!status || (status.confirmationStatus !== 'confirmed' && status.confirmationStatus !== 'finalized')) fail('CONFIRM_UNCERTAIN', `${kind}: ${signature}: no confirmed status`);
  let txInfo = null;
  for (let poll = 0; poll < 5 && !txInfo; poll++) { txInfo = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }); if (!txInfo) await sleep(1000); }
  const ownTrade = kind === 'BUY' ? txInfo?.meta?.logMessages?.map(parseTrade).filter(Boolean).find(x => x.mint === mint.toBase58() && x.isBuy && x.user === wallet.publicKey.toBase58()) : null;
  emit(`${kind.toLowerCase()}_confirmed`, { signature, slot: txInfo?.slot ?? null, feeLamports: txInfo?.meta?.fee ?? null, walletBalanceBeforeLamports: txInfo?.meta?.preBalances?.[0] ?? null, walletBalanceAfterLamports: txInfo?.meta?.postBalances?.[0] ?? null, actualTradeSolLamports: ownTrade?.solAmountLamports ?? null });
  if (kind === 'BUY' && !ownTrade) fail('BUY_AMOUNT_UNKNOWN', signature);
  return { signature, slot: txInfo?.slot ?? (await connection.getSignatureStatuses([signature])).value[0]?.slot ?? null, actualTradeSolLamports: ownTrade?.solAmountLamports ?? null, walletBalanceBeforeLamports: txInfo?.meta?.preBalances?.[0] ?? null, walletBalanceAfterLamports: txInfo?.meta?.postBalances?.[0] ?? null };
}

async function fetchState() {
  const [global, feeConfig, state, mintInfo] = await Promise.all([
    online.fetchGlobal(), online.fetchFeeConfig(), online.fetchBuyState(mint, wallet.publicKey, TOKEN_2022_PROGRAM_ID), connection.getAccountInfo(mint, 'confirmed'),
  ]);
  if (!mintInfo || !mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) fail('MINT_OWNER', 'Unexpected mint program');
  const mintState = unpackMint(mint, mintInfo, TOKEN_2022_PROGRAM_ID);
  const extensions = getExtensionTypes(mintState.tlvData);
  if (extensions.some((e) => !allowedExtensions.has(e))) fail('TOKEN_EXTENSION', JSON.stringify(extensions));
  if (state.bondingCurve.complete) fail('CURVE_COMPLETE', 'Curve has graduated');
  if (!state.bondingCurve.quoteMint.equals(PublicKey.default) && !state.bondingCurve.quoteMint.equals(NATIVE_MINT)) fail('QUOTE_MINT', 'Not SOL');
  return { global, feeConfig, ...state, mintState, extensions };
}

async function getPrice() {
  const response = await fetch('https://api.kraken.com/0/public/Ticker?pair=SOLUSDT', { signal: AbortSignal.timeout(10000) });
  if (!response.ok) fail('PRICE_HTTP', String(response.status));
  const data = await response.json();
  if (data.error?.length) fail('PRICE_API', JSON.stringify(data.error));
  const price = Number(data.result?.SOLUSDT?.c?.[0]);
  if (!Number.isFinite(price) || price < 50 || price > 500) fail('PRICE_INVALID', String(price));
  return price;
}

async function sellPosition(reason, requiredMinimumLamports = null) {
  emit('sell_started', { reason, requiredMinimumLamports: requiredMinimumLamports === null ? null : String(requiredMinimumLamports) });
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const tokenAccount = await getAccount(connection, ata, 'confirmed', TOKEN_2022_PROGRAM_ID);
      const amount = tokenAccount.amount;
      if (amount === 0n) { emit('sell_skipped_zero_balance'); return true; }
      const [state, balance] = await Promise.all([fetchState(), connection.getBalance(wallet.publicKey, 'confirmed')]);
      if (balance < 2000000) fail('SOL_BALANCE', 'Insufficient fee balance for sell');
      const expected = getSellSolAmountFromTokenAmount({ global: state.global, feeConfig: state.feeConfig, mintSupply: toBN(state.mintState.supply), bondingCurve: state.bondingCurve, amount: toBN(amount) });
      if (expected.lte(new BN(0))) fail('SELL_QUOTE', 'Zero expected proceeds');
      if (requiredMinimumLamports !== null && BigInt(expected.toString()) < requiredMinimumLamports) {
        emit('profit_target_deferred', { expectedLamports: expected.toString(), requiredLamports: String(requiredMinimumLamports) });
        return false;
      }
      const minimum = requiredMinimumLamports === null ? expected.muln(process.env.CANARY_RECOVER_SELL === '1' ? 85 : 90).divn(100) : toBN(requiredMinimumLamports);
      const instructions = await PUMP_SDK.sellV2Instructions({ global: state.global, bondingCurveAccountInfo: state.bondingCurveAccountInfo, bondingCurve: state.bondingCurve, mint, user: wallet.publicKey, amount: toBN(amount), quoteAmount: minimum, slippage: 0, tokenProgram: TOKEN_2022_PROGRAM_ID, quoteTokenProgram: TOKEN_PROGRAM_ID });
      emit('sell_quote', { attempt, tokenRaw: String(amount), expectedLamports: expected.toString(), minimumLamports: minimum.toString(), curveRealQuoteLamports: state.bondingCurve.realQuoteReserves.toString() });
      const result = await sendSimulated('SELL', instructions);
      const after = await getAccount(connection, ata, 'confirmed', TOKEN_2022_PROGRAM_ID);
      emit('sell_result', { signature: result.signature, remainingTokenRaw: String(after.amount), walletSol: toSol(await connection.getBalance(wallet.publicKey, 'confirmed')) });
      if (after.amount !== 0n) fail('REMAINING_POSITION', String(after.amount));
      return true;
    } catch (error) {
      emit('sell_attempt_error', { attempt, message: String(error.message ?? error) });
      if (sentCount >= transactionLimit) break;
      await sleep(2500);
    }
  }
  if (requiredMinimumLamports !== null) return false;
  fail('SELL_INCOMPLETE', 'Inspect on-chain position and use recovery before any new buy');
}

try {
  const genesis = await connection.getGenesisHash();
  if (genesis !== process.env.SOLANA_EXPECTED_GENESIS_HASH) fail('GENESIS', genesis);
  if (process.env.CANARY_RECOVER_SELL === '1') {
    const tokenAccount = await getAccount(connection, ata, 'confirmed', TOKEN_2022_PROGRAM_ID);
    emit('recovery_preflight', { tokenRaw: String(tokenAccount.amount), walletLamports: await connection.getBalance(wallet.publicKey, 'confirmed') });
    await sellPosition('recover_expired_sell');
    emit('recovery_complete', { walletLamports: await connection.getBalance(wallet.publicKey, 'confirmed') });
  } else {
  const [price, initialBalance, initialToken] = await Promise.all([
    getPrice(), connection.getBalance(wallet.publicKey, 'confirmed'), connection.getAccountInfo(ata, 'confirmed'),
  ]);
  if (initialToken) fail('EXISTING_POSITION', ata.toBase58());
  if (initialBalance < 30000000) fail('WALLET_BALANCE', String(initialBalance));
  const budgetLamports = Math.floor(LAMPORTS_PER_SOL / price);
  if (budgetLamports < 1000000 || budgetLamports > 20000000) fail('BUDGET', String(budgetLamports));
  const state = await fetchState();
  if (state.bondingCurve.realQuoteReserves.lt(new BN(LAMPORTS_PER_SOL))) fail('CURVE_LIQUIDITY', state.bondingCurve.realQuoteReserves.toString());
  if (state.bondingCurve.realQuoteReserves.gte(toBN(20000000000)) || state.bondingCurve.realTokenReserves.lte(toBN(300000000000000))) fail('CURVE_NEAR_GRADUATION', 'Curve outside bounded entry range');
  const quoteForAmount = Math.floor(budgetLamports * 0.97);
  const tokenAmount = getBuyTokenAmountFromSolAmount({ global: state.global, feeConfig: state.feeConfig, mintSupply: toBN(state.mintState.supply), bondingCurve: state.bondingCurve, amount: toBN(quoteForAmount), quoteMint: NATIVE_MINT });
  const expectedCost = getBuySolAmountFromTokenAmount({ global: state.global, feeConfig: state.feeConfig, mintSupply: toBN(state.mintState.supply), bondingCurve: state.bondingCurve, amount: tokenAmount, quoteMint: NATIVE_MINT });
  const immediateSell = getSellSolAmountFromTokenAmount({ global: state.global, feeConfig: state.feeConfig, mintSupply: toBN(state.mintState.supply), bondingCurve: state.bondingCurve, amount: tokenAmount });
  if (tokenAmount.lte(new BN(0)) || expectedCost.gt(toBN(budgetLamports)) || immediateSell.lte(new BN(0))) fail('REVERSE_QUOTE', 'Cannot bound buy and sell');
  const targetProfitLamports = lamportsForUsdt(targetProfitUsdt, String(price));
  emit('preflight', { mint: mint.toBase58(), wallet: wallet.publicKey.toBase58(), initialWalletLamports: initialBalance, krakenSolUsdt: price, maxBuyLamports: budgetLamports, targetTokenRaw: tokenAmount.toString(), expectedBuyLamports: expectedCost.toString(), immediateSellQuoteLamports: immediateSell.toString(), targetProfitUsdt, targetProfitLamports: String(targetProfitLamports), sellNetworkFeeReserveLamports: String(sellNetworkFeeReserveLamports), curveRealQuoteLamports: state.bondingCurve.realQuoteReserves.toString(), extensions: state.extensions });
  emit('building_buy_instructions');
  const instructions = await PUMP_SDK.buyV2Instructions({ global: state.global, bondingCurveAccountInfo: state.bondingCurveAccountInfo, bondingCurve: state.bondingCurve, associatedUserAccountInfo: state.associatedUserAccountInfo, mint, user: wallet.publicKey, amount: tokenAmount, quoteAmount: toBN(budgetLamports), slippage: 0, tokenProgram: TOKEN_2022_PROGRAM_ID, quoteTokenProgram: TOKEN_PROGRAM_ID });
  emit('buy_instructions_built', { count: instructions.length });
  const buy = await sendSimulated('BUY', instructions);
  if (buy.dryRun) { emit('dry_run_complete'); }
  else {
  ownBuySignature = buy.signature;
  ownBuySlot = buy.slot;
  if (ownBuySlot === null) fail('BUY_SLOT_UNKNOWN', buy.signature);
  const [tokenAccount, tokenAccountInfo] = await Promise.all([getAccount(connection, ata, 'confirmed', TOKEN_2022_PROGRAM_ID), connection.getAccountInfo(ata, 'confirmed')]);
  if (!tokenAccountInfo || buy.walletBalanceBeforeLamports === null || buy.walletBalanceAfterLamports === null) fail('BUY_COST_UNKNOWN', buy.signature);
  const buyCostLamports = BigInt(buy.walletBalanceBeforeLamports) - BigInt(buy.walletBalanceAfterLamports) - BigInt(tokenAccountInfo.lamports);
  if (buyCostLamports <= 0n || buyCostLamports > 20000000n) fail('BUY_COST_INVALID', String(buyCostLamports));
  const requiredQuoteLamports = requiredSellQuoteLamports(buyCostLamports, sellNetworkFeeReserveLamports, targetProfitLamports);
  emit('position_open', { signature: buy.signature, slot: buy.slot, tokenRaw: String(tokenAccount.amount), buySolLamports: buy.actualTradeSolLamports, buyEconomicCostLamports: String(buyCostLamports), tokenAccountRentLamports: tokenAccountInfo.lamports, requiredSellQuoteLamports: String(requiredQuoteLamports), walletSol: toSol(await connection.getBalance(wallet.publicKey, 'confirmed')) });
  const start = Date.now();
  let riskExitReason = null;
  let sold = false;
  while (Date.now() - start < maxHoldMs && !sold && riskExitReason === null) {
    if (stopFile && fs.existsSync(stopFile)) { riskExitReason = 'operator_stop'; break; }
    const curve = await online.fetchBondingCurve(mint);
    if (curve.complete || curve.realQuoteReserves.gte(toBN(70000000000)) || curve.realTokenReserves.lte(toBN(50000000000000))) {
      riskExitReason = 'approaching_curve_graduation';
      emit('risk_exit_triggered', { curveComplete: curve.complete, realQuoteLamports: curve.realQuoteReserves.toString(), realTokenRaw: curve.realTokenReserves.toString() });
      break;
    }
    const [exitState, currentAccount] = await Promise.all([fetchState(), getAccount(connection, ata, 'confirmed', TOKEN_2022_PROGRAM_ID)]);
    if (currentAccount.amount === 0n) { emit('position_already_closed'); sold = true; break; }
    const quote = getSellSolAmountFromTokenAmount({ global: exitState.global, feeConfig: exitState.feeConfig, mintSupply: toBN(exitState.mintState.supply), bondingCurve: exitState.bondingCurve, amount: toBN(currentAccount.amount) });
    const quoteLamports = BigInt(quote.toString());
    emit('price_progress', { elapsedSeconds: Math.round((Date.now() - start) / 1000), expectedSellQuoteLamports: String(quoteLamports), expectedNetProfitLamports: String(expectedNetProfitLamports(quoteLamports, buyCostLamports, sellNetworkFeeReserveLamports)), targetProfitLamports: String(targetProfitLamports), requiredSellQuoteLamports: String(requiredQuoteLamports) });
    if (meetsProfitTarget(quoteLamports, buyCostLamports, sellNetworkFeeReserveLamports, targetProfitLamports)) {
      emit('profit_target_reached', { expectedSellQuoteLamports: String(quoteLamports), requiredSellQuoteLamports: String(requiredQuoteLamports) });
      sold = await sellPosition('net_profit_target', requiredQuoteLamports);
      if (sold) break;
    }
    await sleep(5000);
  }
  if (!sold) await sellPosition(riskExitReason ?? 'max_hold_15_minutes');
  emit('complete', { buySignature: ownBuySignature, exitReason: sold ? 'net_profit_target' : riskExitReason ?? 'max_hold_15_minutes', finalWalletLamports: await connection.getBalance(wallet.publicKey, 'confirmed') });
  }
  }
} catch (error) {
  emit('fatal', { message: String(error.message ?? error), stack: String(error.stack ?? '').split('\n').slice(0, 8), buySignature: ownBuySignature, buySlot: ownBuySlot, sentCount });
  process.exitCode = 1;
}
