export type MissingCanonicalLaunchPolicy = 'ERROR' | 'DISSOLVE_CURRENT';

export function missingCanonicalLaunchPolicy(
  confirmationStatus: 'PROCESSED' | 'CONFIRMED' | 'FINALIZED' | 'ORPHANED',
): MissingCanonicalLaunchPolicy {
  return confirmationStatus === 'ORPHANED' ? 'DISSOLVE_CURRENT' : 'ERROR';
}
