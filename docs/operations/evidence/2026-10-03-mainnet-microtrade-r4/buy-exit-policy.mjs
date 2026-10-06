export function qualifiesExternalBuy(trade, ownBuySlot, ownWallet, ownBuySolLamports) {
  if (!trade || !trade.isBuy || trade.user === ownWallet || trade.slot <= ownBuySlot) return false;
  try { return BigInt(trade.solAmountLamports) > BigInt(ownBuySolLamports); }
  catch { return false; }
}
