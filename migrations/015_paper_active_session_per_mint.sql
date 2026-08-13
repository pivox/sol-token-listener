DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM paper_strategy_sessions
    WHERE state IN (
      'BUY_PENDING','PAPER_HOLDING','WAITING_EXTERNAL_BUYS',
      'EXIT_PENDING_QUOTE','SELL_PENDING'
    )
    GROUP BY mint
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'multiple active paper sessions exist for one mint';
  END IF;
END $$;

DROP INDEX IF EXISTS paper_strategy_sessions_active_idx;

CREATE UNIQUE INDEX IF NOT EXISTS paper_strategy_sessions_active_idx
  ON paper_strategy_sessions(mint)
  WHERE state IN (
    'BUY_PENDING','PAPER_HOLDING','WAITING_EXTERNAL_BUYS','EXIT_PENDING_QUOTE','SELL_PENDING'
  );
