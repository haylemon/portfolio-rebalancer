const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const asyncHandler = require('../middleware/asyncHandler');

// GET /jobs/stats
// IMPORTANT: must be defined before /:id — Express matches routes in registration order,
// so "stats" would be captured as an id param if /:id came first.
router.get('/stats', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT
       status,
       COUNT(*)                                                          AS job_count,
       ROUND(AVG(
         EXTRACT(EPOCH FROM (completed_at - started_at))
       )::numeric, 2)                                                    AS avg_duration_sec,
       ROUND(MAX(
         EXTRACT(EPOCH FROM (completed_at - started_at))
       )::numeric, 2)                                                    AS max_duration_sec,
       COUNT(*) FILTER (
         WHERE status = 'processing'
           AND started_at < NOW() - INTERVAL '10 minutes'
       )                                                                  AS stuck_count
     FROM rebalance_jobs
     GROUP BY status
     ORDER BY
       CASE status
         WHEN 'processing' THEN 1
         WHEN 'pending'    THEN 2
         WHEN 'failed'     THEN 3
         WHEN 'completed'  THEN 4
       END`
  );

  res.json(rows);
}));


// GET /jobs/failed
router.get('/failed', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT
       j.id                                                             AS job_id,
       p.name                                                           AS portfolio_name,
       j.attempts,
       j.error_message,
       ROUND(EXTRACT(
         EPOCH FROM (j.completed_at - j.started_at)
       )::numeric, 2)                                                   AS time_to_failure_sec,
       j.created_at,
       j.completed_at
     FROM rebalance_jobs j
     JOIN portfolios p ON p.id = j.portfolio_id
     WHERE j.status = 'failed'
     ORDER BY j.completed_at DESC
     LIMIT 20`
  );

  res.json(rows);
}));


// GET /jobs
router.get('/', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT
       j.id,
       p.name                                                           AS portfolio_name,
       j.status,
       j.attempts,
       j.error_message,
       j.created_at,
       j.started_at,
       j.completed_at,
       ROUND(EXTRACT(
         EPOCH FROM (j.completed_at - j.started_at)
       )::numeric, 2)                                                   AS duration_sec
     FROM rebalance_jobs j
     JOIN portfolios p ON p.id = j.portfolio_id
     ORDER BY j.created_at DESC
     LIMIT 20`
  );

  res.json(rows);
}));


// GET /jobs/:id
// Returns a single job and all trades executed as part of it.
// Poll this after POST /portfolios/:id/rebalance to check for completion.
router.get('/:id', asyncHandler(async (req, res) => {
  const { rows: jobRows } = await pool.query(
    `SELECT
       j.id,
       p.name                                                           AS portfolio_name,
       j.status,
       j.attempts,
       j.error_message,
       j.created_at,
       j.started_at,
       j.completed_at,
       ROUND(EXTRACT(
         EPOCH FROM (j.completed_at - j.started_at)
       )::numeric, 2)                                                   AS duration_sec
     FROM rebalance_jobs j
     JOIN portfolios p ON p.id = j.portfolio_id
     WHERE j.id = $1`,
    [req.params.id]
  );

  if (jobRows.length === 0) {
    return res.status(404).json({ error: 'Job not found' });
  }

  const { rows: trades } = await pool.query(
    `SELECT
       symbol,
       side,
       ROUND(quantity::numeric, 4)    AS quantity,
       ROUND(price::numeric, 2)       AS price,
       ROUND(total_value::numeric, 2) AS total_value,
       executed_at
     FROM trades
     WHERE rebalance_job_id = $1
     ORDER BY executed_at`,
    [req.params.id]
  );

  res.json({ job: jobRows[0], trades });
}));


module.exports = router;
