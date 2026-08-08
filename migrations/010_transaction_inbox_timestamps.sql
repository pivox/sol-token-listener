ALTER TABLE chain_transaction_inbox
  ALTER COLUMN created_at SET DEFAULT statement_timestamp(),
  ALTER COLUMN updated_at SET DEFAULT statement_timestamp();
