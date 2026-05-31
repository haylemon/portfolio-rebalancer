-- ============================================================
-- Portfolio Rebalancer — SQL Query Reference
-- ============================================================
-- Run any block in psql with: psql $DATABASE_URL
-- Replace :portfolio_id with a real UUID when prompted, or use:
--   \set portfolio_id 'your-uuid-here'
-- ============================================================


-- ============================================================
-- 1. PORTFOLIO CURRENT VALUE
--
-- Purpose: what is a portfolio worth right now, broken down
--          into cash vs holdings?
--
-- Reasoning: LEFT JOIN is used instead of INNER JOIN because a
-- portfolio with no holdings must still return a row (total value
-- = cash). COALESCE turns the NULL sum into 0 in that case.
--
-- Performance: this query touches portfolios, holdings, and prices.
-- holdings(portfolio_id) index means the join scans only the rows
-- for this portfolio, not the whole table.
--
-- Index that helps: idx_holdings_portfolio_id (already created)
-- ============================================================
SELECT
  p.id,
  p.name,
  p.cash_balance,
  COALESCE(SUM(h.quantity * pr.price), 0)                        AS holdings_value,
  p.cash_balance + COALESCE(SUM(h.quantity * pr.price), 0)       AS total_value,
  COUNT(h.id)                                                     AS position_count
FROM portfolios p
LEFT JOIN holdings h  ON h.portfolio_id = p.id
LEFT JOIN prices   pr ON pr.symbol = h.symbol
WHERE p.id = :'portfolio_id'
GROUP BY p.id, p.name, p.cash_balance;


-- ============================================================
-- 2. ALLOCATION DRIFT DETECTION
--
-- Purpose: for each symbol in the target allocation, show how
--          far the current holding drifts from the target weight.
--          This is the query that tells you whether a rebalance
--          is needed and how urgently.
--
-- Reasoning: CTEs break the problem into steps so each piece
-- is readable in isolation. The first CTE computes total value.
-- The second expands the JSONB target_allocations column into
-- rows using jsonb_each_text(). The final SELECT joins both
-- to compute drift percentages.
--
-- The CASE at the end classifies drift severity — this is the
-- kind of business logic that belongs in SQL when it drives
-- downstream decisions (e.g. only rebalance if drift is HIGH).
--
-- jsonb_each_text() turns {"AAPL": 0.6} into a row (AAPL, "0.6").
-- The cast ::numeric converts the text value for arithmetic.
--
-- Performance: total_value requires aggregating all holdings for
-- the portfolio. The drift calculation then joins that result
-- against holdings and prices again. For large portfolios with
-- many symbols this is fine — for a system with thousands of
-- portfolios needing batch drift checks, you'd materialise the
-- totals in a separate table.
--
-- Index that helps: idx_holdings_portfolio_id, prices pkey
-- ============================================================
WITH portfolio_total AS (
  SELECT
    p.id,
    p.cash_balance,
    p.target_allocations,
    p.cash_balance + COALESCE(SUM(h.quantity * pr.price), 0) AS total_value
  FROM portfolios p
  LEFT JOIN holdings h  ON h.portfolio_id = p.id
  LEFT JOIN prices   pr ON pr.symbol = h.symbol
  WHERE p.id = :'portfolio_id'
  GROUP BY p.id, p.cash_balance, p.target_allocations
),
target_weights AS (
  -- Expand the JSONB column into one row per target symbol.
  SELECT
    key                    AS symbol,
    value::numeric         AS target_weight
  FROM portfolio_total, jsonb_each_text(target_allocations)
)
SELECT
  tw.symbol,
  COALESCE(ROUND((h.quantity * pr.price)::numeric, 2), 0)          AS current_value,
  ROUND(COALESCE(h.quantity * pr.price / pt.total_value, 0)
        * 100, 2)                                                    AS current_pct,
  ROUND(tw.target_weight * 100, 2)                                  AS target_pct,
  ROUND(
    (COALESCE(h.quantity * pr.price / pt.total_value, 0)
     - tw.target_weight) * 100,
    2
  )                                                                  AS drift_pct,
  CASE
    WHEN ABS(COALESCE(h.quantity * pr.price / pt.total_value, 0)
             - tw.target_weight) > 0.05 THEN 'HIGH'
    WHEN ABS(COALESCE(h.quantity * pr.price / pt.total_value, 0)
             - tw.target_weight) > 0.02 THEN 'MEDIUM'
    ELSE 'LOW'
  END                                                                AS drift_severity
FROM target_weights tw
CROSS JOIN portfolio_total pt
LEFT JOIN holdings h  ON h.portfolio_id = pt.id AND h.symbol = tw.symbol
LEFT JOIN prices   pr ON pr.symbol = tw.symbol
ORDER BY ABS(drift_pct) DESC;


-- ============================================================
-- 3. TRADE HISTORY WITH RUNNING P&L (WINDOW FUNCTION)
--
-- Purpose: show every trade executed for a portfolio, with a
--          running profit/loss figure per symbol that accumulates
--          over time. Sells add to P&L (cash in), buys subtract
--          (cash out).
--
-- Reasoning: this uses a window function (SUM ... OVER) instead
-- of a subquery or application-level loop. The window function
-- computes a running total without collapsing rows — each trade
-- row keeps its own data AND gets the accumulated total up to
-- that point.
--
-- PARTITION BY symbol means the running total resets per symbol,
-- not across the whole portfolio. ORDER BY executed_at defines
-- the accumulation order. ROWS BETWEEN UNBOUNDED PRECEDING AND
-- CURRENT ROW is explicit about what "running" means — all rows
-- from the start up to and including this one.
--
-- This is the same pattern used in financial reporting to produce
-- "equity curves" — a time series of cumulative P&L.
--
-- Performance: window functions require sorting. The index on
-- (portfolio_id, executed_at) lets PostgreSQL avoid a full table
-- sort by reading the index in order.
--
-- Index that helps: idx_trades_portfolio_executed (already created)
-- ============================================================
SELECT
  t.executed_at,
  t.symbol,
  t.side,
  ROUND(t.quantity::numeric, 4)     AS quantity,
  ROUND(t.price::numeric, 2)        AS price,
  ROUND(t.total_value::numeric, 2)  AS trade_value,
  ROUND(
    SUM(
      CASE WHEN t.side = 'sell' THEN  t.total_value
           WHEN t.side = 'buy'  THEN -t.total_value
      END
    ) OVER (
      PARTITION BY t.symbol
      ORDER BY t.executed_at
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    )::numeric,
    2
  )                                  AS running_pnl_by_symbol,
  rj.status                          AS job_status
FROM trades t
JOIN rebalance_jobs rj ON rj.id = t.rebalance_job_id
WHERE t.portfolio_id = :'portfolio_id'
ORDER BY t.executed_at ASC, t.symbol;


-- ============================================================
-- 4. TRADE VOLUME SUMMARY BY SYMBOL (CONDITIONAL AGGREGATION)
--
-- Purpose: for each symbol ever traded in a portfolio, how many
--          total shares were bought vs sold, and at what average
--          price? This is a pivot-style summary using CASE inside
--          aggregate functions.
--
-- Reasoning: conditional aggregation (SUM(CASE WHEN side='buy'
-- THEN quantity END)) avoids joining against a filtered subquery.
-- One pass over the trades table produces buy/sell columns side
-- by side. This pattern is common in reporting queries.
--
-- net_position shows whether the portfolio is currently long
-- (more bought than sold) or fully flat for that symbol.
--
-- Performance: GROUP BY symbol with the portfolio_id filter
-- uses the idx_trades_portfolio_executed index to locate rows.
-- ============================================================
SELECT
  symbol,
  COUNT(*)                                                         AS total_trades,
  SUM(CASE WHEN side = 'buy'  THEN quantity ELSE 0 END)          AS shares_bought,
  SUM(CASE WHEN side = 'sell' THEN quantity ELSE 0 END)          AS shares_sold,
  SUM(CASE WHEN side = 'buy'  THEN quantity ELSE 0 END)
    - SUM(CASE WHEN side = 'sell' THEN quantity ELSE 0 END)       AS net_position,
  ROUND(SUM(CASE WHEN side = 'buy'  THEN total_value ELSE 0 END)
        ::numeric, 2)                                             AS total_buy_value,
  ROUND(SUM(CASE WHEN side = 'sell' THEN total_value ELSE 0 END)
        ::numeric, 2)                                             AS total_sell_value,
  ROUND(AVG(price)::numeric, 4)                                   AS avg_execution_price
FROM trades
WHERE portfolio_id = :'portfolio_id'
GROUP BY symbol
ORDER BY total_trades DESC;


-- ============================================================
-- 5. JOB QUEUE MONITORING
--
-- Purpose: operational view of the job queue — how many jobs
--          in each state, average processing time, and whether
--          any jobs are stuck.
--
-- Reasoning: GROUP BY status gives a one-row summary per state.
-- EXTRACT(EPOCH FROM ...) converts an interval to seconds,
-- making it easy to spot slow jobs. The stuck_count subquery
-- is the same check the worker's crash recovery logic uses —
-- useful for an ops dashboard to show the same view.
--
-- Performance: this is a full scan of rebalance_jobs, which is
-- acceptable for an operational query run infrequently. At
-- large scale you'd add a created_at range filter.
--
-- Index that helps: idx_rebalance_jobs_status_created
-- ============================================================
SELECT
  status,
  COUNT(*)                                                         AS job_count,
  ROUND(AVG(
    EXTRACT(EPOCH FROM (completed_at - started_at))
  )::numeric, 2)                                                   AS avg_duration_sec,
  ROUND(MAX(
    EXTRACT(EPOCH FROM (completed_at - started_at))
  )::numeric, 2)                                                   AS max_duration_sec,
  MIN(created_at)                                                  AS oldest_job,
  MAX(created_at)                                                  AS newest_job,
  -- Jobs stuck in processing longer than 10 minutes.
  -- A non-zero value here means a worker crashed mid-job.
  COUNT(*) FILTER (
    WHERE status = 'processing'
      AND started_at < NOW() - INTERVAL '10 minutes'
  )                                                                AS stuck_count
FROM rebalance_jobs
GROUP BY status
ORDER BY
  CASE status
    WHEN 'processing' THEN 1
    WHEN 'pending'    THEN 2
    WHEN 'failed'     THEN 3
    WHEN 'completed'  THEN 4
  END;


-- ============================================================
-- 6. FAILED JOB REPORT
--
-- Purpose: list recent failures with enough context to understand
--          what went wrong and for which portfolio.
--
-- Reasoning: joining against portfolios gives the portfolio name
--            alongside the error, which is far more useful than
--            a bare portfolio_id when diagnosing issues.
--            Ordering by completed_at DESC surfaces the most recent
--            failures first.
--
-- The time_to_failure column shows how long the job ran before it
-- failed — a job that fails instantly (bad input) looks very
-- different from one that fails after 30 seconds (timeout or DB error).
--
-- Performance: the WHERE status='failed' filter combined with the
-- (status, created_at) index lets PostgreSQL skip completed and
-- pending jobs entirely.
--
-- Index that helps: idx_rebalance_jobs_status_created
-- ============================================================
SELECT
  j.id                                                            AS job_id,
  p.name                                                          AS portfolio_name,
  j.attempts,
  j.error_message,
  ROUND(EXTRACT(
    EPOCH FROM (j.completed_at - j.started_at)
  )::numeric, 2)                                                  AS time_to_failure_sec,
  j.created_at,
  j.completed_at
FROM rebalance_jobs j
JOIN portfolios p ON p.id = j.portfolio_id
WHERE j.status = 'failed'
ORDER BY j.completed_at DESC
LIMIT 20;


-- ============================================================
-- 7. SYSTEM-WIDE PORTFOLIO SUMMARY
--
-- Purpose: one row per portfolio showing total value, number of
--          positions, and job health. Useful as a dashboard
--          overview across all portfolios.
--
-- Reasoning: this uses correlated subqueries for the job counts.
-- An alternative is to LEFT JOIN against a pre-aggregated jobs
-- CTE. The correlated subquery approach is simpler to read here
-- because there are only two extra columns and the jobs table
-- is small. For very large datasets the CTE approach is faster.
--
-- Performance: each portfolio requires aggregating its holdings.
-- If you have thousands of portfolios this query gets expensive.
-- In production you'd materialise total_value in the portfolios
-- table and refresh it after each rebalance, then this query
-- becomes a simple scan.
--
-- Index that helps: idx_holdings_portfolio_id, idx_rebalance_jobs_status_created
-- ============================================================
SELECT
  p.name,
  ROUND(p.cash_balance::numeric, 2)                              AS cash,
  ROUND(COALESCE(SUM(h.quantity * pr.price), 0)::numeric, 2)    AS holdings_value,
  ROUND((p.cash_balance
    + COALESCE(SUM(h.quantity * pr.price), 0))::numeric, 2)     AS total_value,
  COUNT(h.id)                                                    AS positions,
  (SELECT COUNT(*)
   FROM rebalance_jobs rj
   WHERE rj.portfolio_id = p.id)                                 AS total_jobs,
  (SELECT COUNT(*)
   FROM rebalance_jobs rj
   WHERE rj.portfolio_id = p.id
     AND rj.status = 'failed')                                   AS failed_jobs
FROM portfolios p
LEFT JOIN holdings h  ON h.portfolio_id = p.id
LEFT JOIN prices   pr ON pr.symbol = h.symbol
GROUP BY p.id, p.name, p.cash_balance
ORDER BY total_value DESC;


-- ============================================================
-- 8. ACTIVE ROW LOCKS (DEBUGGING)
--
-- Purpose: observe which connections are holding or waiting for
--          locks during concurrent operations. Run this in a
--          separate psql session while a rebalance is executing
--          to see the FOR UPDATE lock in action.
--
-- Reasoning: pg_locks is a system view that exposes the lock
-- manager's state. granted=true means the lock is held;
-- granted=false means the process is waiting for it.
-- Joining against pg_stat_activity shows what query each
-- process is running — essential for understanding deadlocks.
--
-- This query is for development and debugging only.
-- Do not expose it through the API.
-- ============================================================
SELECT
  l.pid,
  l.granted,
  l.mode,
  l.relation::regclass                AS locked_table,
  LEFT(a.query, 60)                   AS query_snippet,
  NOW() - a.query_start               AS query_duration
FROM pg_locks l
JOIN pg_stat_activity a ON a.pid = l.pid
WHERE l.relation IS NOT NULL
  AND l.relation::regclass::text IN ('portfolios','holdings','rebalance_jobs')
  AND l.pid <> pg_backend_pid()
ORDER BY l.granted, a.query_start;
