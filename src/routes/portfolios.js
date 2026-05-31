const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const asyncHandler = require('../middleware/asyncHandler');

// POST /portfolios
router.post('/', asyncHandler(async (req, res) => {
  const { name, cash_balance, target_allocations } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (cash_balance == null || cash_balance < 0) {
    return res.status(400).json({ error: 'cash_balance must be a non-negative number' });
  }
  if (!target_allocations || typeof target_allocations !== 'object') {
    return res.status(400).json({ error: 'target_allocations must be an object e.g. { "AAPL": 0.6, "MSFT": 0.4 }' });
  }

  const totalWeight = Object.values(target_allocations).reduce((sum, w) => sum + w, 0);
  if (totalWeight > 1.0001) {
    return res.status(400).json({ error: `Target allocation weights sum to ${totalWeight.toFixed(4)}, must be <= 1.0` });
  }

  const { rows } = await pool.query(
    `INSERT INTO portfolios (name, cash_balance, target_allocations)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [name, cash_balance, JSON.stringify(target_allocations)]
  );

  res.status(201).json(rows[0]);
}));


// GET /portfolios/:id
router.get('/:id', asyncHandler(async (req, res) => {
  const { rows: portfolioRows } = await pool.query(
    `SELECT * FROM portfolios WHERE id = $1`,
    [req.params.id]
  );

  if (portfolioRows.length === 0) {
    return res.status(404).json({ error: 'Portfolio not found' });
  }

  const portfolio = portfolioRows[0];

  const { rows: holdings } = await pool.query(
    `SELECT h.symbol, h.quantity, p.price,
            ROUND(h.quantity * p.price, 2) AS market_value
     FROM holdings h
     LEFT JOIN prices p ON p.symbol = h.symbol
     WHERE h.portfolio_id = $1
     ORDER BY h.symbol`,
    [req.params.id]
  );

  const holdingsValue = holdings.reduce((sum, h) => sum + parseFloat(h.market_value || 0), 0);
  const totalValue    = holdingsValue + parseFloat(portfolio.cash_balance);

  res.json({ ...portfolio, holdings, total_value: totalValue.toFixed(2) });
}));


// POST /portfolios/:id/deposit
router.post('/:id/deposit', asyncHandler(async (req, res) => {
  const { amount } = req.body;

  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }

  const { rows } = await pool.query(
    `UPDATE portfolios
     SET cash_balance = cash_balance + $1
     WHERE id = $2
     RETURNING *`,
    [amount, req.params.id]
  );

  if (rows.length === 0) {
    return res.status(404).json({ error: 'Portfolio not found' });
  }

  res.json(rows[0]);
}));


// POST /portfolios/:id/rebalance
// Queues a rebalance job and returns 202 Accepted immediately.
// 202 means "received, not yet processed" — poll GET /jobs/:id for the result.
router.post('/:id/rebalance', asyncHandler(async (req, res) => {
  const { rows: portfolioRows } = await pool.query(
    `SELECT id FROM portfolios WHERE id = $1`,
    [req.params.id]
  );

  if (portfolioRows.length === 0) {
    return res.status(404).json({ error: 'Portfolio not found' });
  }

  try {
    const { rows: jobRows } = await pool.query(
      `INSERT INTO rebalance_jobs (portfolio_id)
       VALUES ($1)
       RETURNING id, status, created_at`,
      [req.params.id]
    );

    res.status(202).json({
      message: 'Rebalance job queued. Poll GET /jobs/:id for status.',
      job: jobRows[0],
    });
  } catch (err) {
    // 23505 = unique_violation. The partial unique index blocks a second active
    // job for the same portfolio — only the database can enforce this atomically.
    if (err.code === '23505') {
      return res.status(409).json({
        error: 'A rebalance job is already queued or running for this portfolio',
      });
    }
    throw err;
  }
}));


// GET /portfolios/:id/summary
router.get('/:id/summary', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT
       p.id,
       p.name,
       ROUND(p.cash_balance::numeric, 2)                             AS cash_balance,
       ROUND(COALESCE(SUM(h.quantity * pr.price), 0)::numeric, 2)   AS holdings_value,
       ROUND((p.cash_balance
         + COALESCE(SUM(h.quantity * pr.price), 0))::numeric, 2)    AS total_value,
       COUNT(h.id)                                                    AS position_count
     FROM portfolios p
     LEFT JOIN holdings h  ON h.portfolio_id = p.id
     LEFT JOIN prices   pr ON pr.symbol = h.symbol
     WHERE p.id = $1
     GROUP BY p.id, p.name, p.cash_balance`,
    [req.params.id]
  );

  if (rows.length === 0) {
    return res.status(404).json({ error: 'Portfolio not found' });
  }

  res.json(rows[0]);
}));


// GET /portfolios/:id/drift
// Shows current vs target weight per symbol, with drift percentage and severity.
router.get('/:id/drift', asyncHandler(async (req, res) => {
  const { rows: portfolioCheck } = await pool.query(
    `SELECT id FROM portfolios WHERE id = $1`, [req.params.id]
  );
  if (portfolioCheck.length === 0) {
    return res.status(404).json({ error: 'Portfolio not found' });
  }

  const { rows } = await pool.query(
    `WITH portfolio_total AS (
       SELECT
         p.id,
         p.cash_balance,
         p.target_allocations,
         p.cash_balance + COALESCE(SUM(h.quantity * pr.price), 0) AS total_value
       FROM portfolios p
       LEFT JOIN holdings h  ON h.portfolio_id = p.id
       LEFT JOIN prices   pr ON pr.symbol = h.symbol
       WHERE p.id = $1
       GROUP BY p.id, p.cash_balance, p.target_allocations
     ),
     target_weights AS (
       SELECT
         key            AS symbol,
         value::numeric AS target_weight
       FROM portfolio_total, jsonb_each_text(target_allocations)
     )
     SELECT
       tw.symbol,
       ROUND(COALESCE(h.quantity * pr.price, 0)::numeric, 2)          AS current_value,
       ROUND(COALESCE(h.quantity * pr.price / NULLIF(pt.total_value,0), 0)
             * 100, 2)                                                  AS current_pct,
       ROUND(tw.target_weight * 100, 2)                                AS target_pct,
       ROUND(
         (COALESCE(h.quantity * pr.price / NULLIF(pt.total_value,0), 0)
          - tw.target_weight) * 100,
         2
       )                                                                AS drift_pct,
       CASE
         WHEN ABS(COALESCE(h.quantity * pr.price / NULLIF(pt.total_value,0), 0)
                  - tw.target_weight) > 0.05 THEN 'HIGH'
         WHEN ABS(COALESCE(h.quantity * pr.price / NULLIF(pt.total_value,0), 0)
                  - tw.target_weight) > 0.02 THEN 'MEDIUM'
         ELSE 'LOW'
       END                                                              AS drift_severity
     FROM target_weights tw
     CROSS JOIN portfolio_total pt
     LEFT JOIN holdings h  ON h.portfolio_id = pt.id AND h.symbol = tw.symbol
     LEFT JOIN prices   pr ON pr.symbol = tw.symbol
     ORDER BY ABS(drift_pct) DESC`,
    [req.params.id]
  );

  res.json(rows);
}));


// GET /portfolios/:id/trades
// Trade history with a running P&L per symbol.
router.get('/:id/trades', asyncHandler(async (req, res) => {
  const { rows: portfolioCheck } = await pool.query(
    `SELECT id FROM portfolios WHERE id = $1`, [req.params.id]
  );
  if (portfolioCheck.length === 0) {
    return res.status(404).json({ error: 'Portfolio not found' });
  }

  const { rows } = await pool.query(
    `SELECT
       t.executed_at,
       t.symbol,
       t.side,
       ROUND(t.quantity::numeric, 4)    AS quantity,
       ROUND(t.price::numeric, 2)       AS price,
       ROUND(t.total_value::numeric, 2) AS trade_value,
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
       )                                AS running_pnl
     FROM trades t
     WHERE t.portfolio_id = $1
     ORDER BY t.executed_at ASC, t.symbol`,
    [req.params.id]
  );

  res.json(rows);
}));


module.exports = router;
