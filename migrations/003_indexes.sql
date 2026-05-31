-- Analytics indexes added separately from the schema migration.
-- Rule: only add an index when you can name the specific query it helps.
-- Each index adds overhead to every INSERT and UPDATE on the table.

-- Supports GET /jobs/failed — finds failed jobs sorted by completion time.
CREATE INDEX IF NOT EXISTS idx_rebalance_jobs_failed
  ON rebalance_jobs (completed_at DESC)
  WHERE status = 'failed';

-- Covering index for holdings aggregation — lets PostgreSQL satisfy the query
-- without reading the main table (index-only scan).
CREATE INDEX IF NOT EXISTS idx_holdings_covering
  ON holdings (portfolio_id, symbol, quantity);

-- Note: no index added on (trades.symbol, executed_at) — the existing
-- idx_trades_portfolio_executed is sufficient until profiling shows otherwise.
