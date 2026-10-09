-- Takeover precondition (spec 9.2, step 1): trading fully stopped. Expected line: 0|0|0|0
-- (active envelopes | armed or locked armaments | open positions | non-terminal signed transactions).
SELECT (SELECT count(*) FROM execution_entry_envelopes WHERE state = 'ACTIVE')
  || '|' || (SELECT count(*) FROM execution_activation_armaments WHERE state IN ('ARMED', 'LOCKED'))
  || '|' || (SELECT count(*) FROM execution_live_positions WHERE state IN ('OPEN', 'EXIT_PENDING', 'UNKNOWN'))
  || '|' || (SELECT count(*) FROM execution_signed_transactions
             WHERE state NOT IN ('RECONCILED', 'REVOKED_NO_SEND'));
