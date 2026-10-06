export function failedBuyNeedsRecovery(status, tokenAccountExists) {
  return !(status?.confirmationStatus === 'finalized' && status.err && !tokenAccountExists);
}
