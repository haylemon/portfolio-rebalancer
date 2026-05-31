-- Portfolio Rebalancer Schema
-- PostgreSQL 13+ required (uses gen_random_uuid() built-in)

CREATE TABLE IF NOT EXISTS portfolios (
  id                 UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  name               TEXT          NOT NULL,
  cash_balance       NUMERIC(15,2) NOT NULL DEFAULT 0
                       CHECK (cash_balance >= 0),
  -- target_allocations example: {"AAPL": 0.60, "MSFT": 0.40}
  -- Weights must sum to <= 1.0. Any remainder is held as cash.
  target_allocations JSONB         NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS holdings (
  id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id UUID          NOT NULL REFERENCES portfolios(id),
  symbol       TEXT          NOT NULL,
  quantity     NUMERIC(15,6) NOT NULL DEFAULT 0
                 CHECK (quantity >= 0),
  updated_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  -- UNIQUE required for the upsert pattern used during rebalancing.
  UNIQUE (portfolio_id, symbol)
);

CREATE TABLE IF NOT EXISTS prices (
  -- symbol is the natural primary key — no surrogate needed.
  symbol     TEXT          PRIMARY KEY,
  price      NUMERIC(15,6) NOT NULL
               CHECK (price > 0),
  updated_at TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Status lifecycle: pending -> processing -> completed
--                                        -> failed
CREATE TABLE IF NOT EXISTS rebalance_jobs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id  UUID        NOT NULL REFERENCES portfolios(id),
  status        TEXT        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempts      INTEGER     NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ
);

-- Append-only audit log — rows are never updated or deleted after insertion.
-- total_value is stored (not computed) so the record is accurate even if prices change later.
CREATE TABLE IF NOT EXISTS trades (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id     UUID          NOT NULL REFERENCES portfolios(id),
  rebalance_job_id UUID          NOT NULL REFERENCES rebalance_jobs(id),
  symbol           TEXT          NOT NULL,
  side             TEXT          NOT NULL
                     CHECK (side IN ('buy', 'sell')),
  quantity         NUMERIC(15,6) NOT NULL CHECK (quantity > 0),
  price            NUMERIC(15,6) NOT NULL CHECK (price > 0),
  total_value      NUMERIC(15,2) NOT NULL,
  executed_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_holdings_portfolio_id
  ON holdings (portfolio_id);

-- Composite index covers the worker's poll query: WHERE status = 'pending' ORDER BY created_at.
CREATE INDEX IF NOT EXISTS idx_rebalance_jobs_status_created
  ON rebalance_jobs (status, created_at);

CREATE INDEX IF NOT EXISTS idx_trades_portfolio_executed
  ON trades (portfolio_id, executed_at);
