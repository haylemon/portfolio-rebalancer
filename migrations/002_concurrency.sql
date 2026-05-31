-- Partial unique index: only one active (pending or processing) job per portfolio at a time.
-- An app-level check isn't safe here — two concurrent requests can both pass the check
-- and both insert. The database enforces this constraint atomically.
-- Completed and failed jobs are excluded, so a portfolio can have many historical jobs.
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_job_per_portfolio
  ON rebalance_jobs (portfolio_id)
  WHERE status IN ('pending', 'processing');
