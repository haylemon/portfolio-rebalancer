const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const asyncHandler = require('../middleware/asyncHandler');

// GET /prices
router.get('/', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT symbol, price, updated_at FROM prices ORDER BY symbol`
  );
  res.json(rows);
}));


// POST /prices/:symbol
// Body: { price, as_of? }
// The optional as_of timestamp prevents an older price from overwriting a newer one
// if updates arrive out of order. The WHERE clause on the upsert silently rejects
// any update where the incoming timestamp is not newer than what's stored.
router.post('/:symbol', asyncHandler(async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const { price, as_of } = req.body;

  if (!price || price <= 0) {
    return res.status(400).json({ error: 'price must be a positive number' });
  }

  const timestamp = as_of ? new Date(as_of) : new Date();

  const { rows } = await pool.query(
    `INSERT INTO prices (symbol, price, updated_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (symbol)
     DO UPDATE SET
       price      = EXCLUDED.price,
       updated_at = EXCLUDED.updated_at
     WHERE prices.updated_at < EXCLUDED.updated_at
     RETURNING *`,
    [symbol, price, timestamp]
  );

  if (rows.length === 0) {
    const { rows: current } = await pool.query(
      `SELECT * FROM prices WHERE symbol = $1`, [symbol]
    );
    return res.status(409).json({
      error: 'A newer price already exists for this symbol',
      current: current[0],
    });
  }

  res.json(rows[0]);
}));

module.exports = router;
