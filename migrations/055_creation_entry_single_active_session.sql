DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM paper_strategy_sessions
    WHERE strategy_id = 'creation-entry-v1'
      AND state IN (
        'BUY_PENDING','PAPER_HOLDING','WAITING_EXTERNAL_BUYS',
        'EXIT_PENDING_QUOTE','SELL_PENDING'
      )
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'multiple active creation-entry-v1 paper sessions exist';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS
  paper_strategy_sessions_creation_entry_active_singleton_idx
  ON paper_strategy_sessions ((1))
  WHERE strategy_id = 'creation-entry-v1'
    AND state IN (
      'BUY_PENDING','PAPER_HOLDING','WAITING_EXTERNAL_BUYS',
      'EXIT_PENDING_QUOTE','SELL_PENDING'
    );
