// Acquire before signature/mint advisory locks and all data-row locks. Writers
// share the fence; retention is exclusive, so projection and deferred expiry
// have a transaction-wide ordering without serializing writers with each other.
export const FOUNDATION_RETENTION_SHARED_FENCE_SQL =
  "SELECT pg_advisory_xact_lock_shared(hashtextextended('foundation-retention-fence:v1', 0))";
export const FOUNDATION_RETENTION_EXCLUSIVE_FENCE_SQL =
  "SELECT pg_advisory_xact_lock(hashtextextended('foundation-retention-fence:v1', 0))";
