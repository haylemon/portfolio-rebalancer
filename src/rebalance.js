const pool   = require('./db/pool');
const logger = require('./logger');

// Pure function — no database calls, no side effects.
// Takes current portfolio state and returns the trades needed to reach target allocations.
function calculateTrades(portfolio, holdings, prices) {
  const holdingsMap = {};
  for (const h of holdings) {
    holdingsMap[h.symbol] = parseFloat(h.quantity);
  }

  let holdingsValue = 0;
  for (const h of holdings) {
    const price = prices[h.symbol];
    if (price) {
      holdingsValue += holdingsMap[h.symbol] * price;
    }
  }
  const cashBalance = parseFloat(portfolio.cash_balance);
  const totalValue  = holdingsValue + cashBalance;

  if (totalValue <= 0) {
    throw new Error('Portfolio has no value to rebalance');
  }

  const trades = [];
  let netCashChange = 0;

  for (const [symbol, targetWeight] of Object.entries(portfolio.target_allocations)) {
    const price = prices[symbol];

    if (!price || price <= 0) {
      throw new Error(`No valid price for symbol: ${symbol}`);
    }

    const currentQuantity = holdingsMap[symbol] || 0;
    const currentValue    = currentQuantity * price;
    const targetValue     = totalValue * targetWeight;
    const valueDelta      = targetValue - currentValue;

    // Skip trades smaller than one cent — avoids floating point noise.
    if (Math.abs(valueDelta) < 0.01) continue;

    const rawQuantity = Math.abs(valueDelta) / price;
    // Round to 6 decimal places — fractional shares are common in real systems.
    const quantity = parseFloat(rawQuantity.toFixed(6));

    if (quantity === 0) continue;

    const side = valueDelta > 0 ? 'buy' : 'sell';

    const newQuantity = side === 'buy'
      ? parseFloat((currentQuantity + quantity).toFixed(6))
      : parseFloat((currentQuantity - quantity).toFixed(6));

    if (newQuantity < 0) {
      throw new Error(
        `Sell quantity for ${symbol} exceeds held quantity. ` +
        `Held: ${currentQuantity}, attempting to sell: ${quantity}`
      );
    }

    // Store total value at execution time so the trade record is accurate
    // even if prices change later.
    const tradeValue = parseFloat((quantity * price).toFixed(2));

    trades.push({ symbol, side, quantity, price, totalValue: tradeValue, newQuantity });

    // Sells add to cash, buys spend it.
    netCashChange += side === 'sell' ? tradeValue : -tradeValue;
  }

  return { trades, netCashChange };
}


// Runs inside an already-open transaction (receives a pg client, not the pool).
// Reads portfolio state, calculates trades, then writes everything atomically.
async function executeRebalance(client, jobId, portfolioId) {
  // Lock the portfolio row for the duration of this transaction.
  // Prevents two rebalances from running concurrently on the same portfolio.
  const { rows: portfolioRows } = await client.query(
    `SELECT id, cash_balance, target_allocations
     FROM portfolios
     WHERE id = $1
     FOR UPDATE`,
    [portfolioId]
  );

  if (portfolioRows.length === 0) {
    throw new Error('Portfolio not found');
  }

  const portfolio    = portfolioRows[0];
  const targetSymbols = Object.keys(portfolio.target_allocations);

  if (targetSymbols.length === 0) {
    throw new Error('Portfolio has no target allocations defined');
  }

  // Lock holdings rows to prevent a concurrent deposit or adjustment from
  // changing quantities while we calculate and apply trades.
  const { rows: holdings } = await client.query(
    `SELECT symbol, quantity
     FROM holdings
     WHERE portfolio_id = $1
     FOR UPDATE`,
    [portfolioId]
  );

  // No lock on prices — we snapshot prices at this moment and use them throughout.
  // If prices change mid-transaction, we correctly execute against what we read.
  const { rows: priceRows } = await client.query(
    `SELECT symbol, price
     FROM prices
     WHERE symbol = ANY($1)`,
    [targetSymbols]
  );

  if (priceRows.length === 0) {
    throw new Error('No prices found. Seed the prices table before rebalancing.');
  }

  const prices = {};
  for (const row of priceRows) {
    prices[row.symbol] = parseFloat(row.price);
  }

  for (const symbol of targetSymbols) {
    if (!prices[symbol]) {
      throw new Error(`No price found for symbol: ${symbol}`);
    }
  }

  const { trades, netCashChange } = calculateTrades(portfolio, holdings, prices);

  logger.info('rebalance_calculated', {
    job_id:          jobId,
    portfolio_id:    portfolioId,
    trade_count:     trades.length,
    net_cash_change: netCashChange.toFixed(2),
    trades:          trades.map(t => ({ symbol: t.symbol, side: t.side, quantity: t.quantity })),
  });

  if (trades.length === 0) {
    logger.info('rebalance_skipped', { job_id: jobId, reason: 'already balanced' });
    return { trades: [], message: 'Portfolio already balanced — no trades required' };
  }

  const newCashBalance = parseFloat(portfolio.cash_balance) + netCashChange;
  if (newCashBalance < 0) {
    throw new Error(
      `Insufficient cash for rebalance. ` +
      `Available: $${parseFloat(portfolio.cash_balance).toFixed(2)}, ` +
      `Net cost: $${Math.abs(netCashChange).toFixed(2)}`
    );
  }

  // All writes happen inside this transaction — if any insert fails,
  // everything rolls back and no partial state is committed.
  for (const trade of trades) {
    await client.query(
      `INSERT INTO trades
         (portfolio_id, rebalance_job_id, symbol, side, quantity, price, total_value)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [portfolioId, jobId, trade.symbol, trade.side, trade.quantity, trade.price, trade.totalValue]
    );

    logger.debug('trade_executed', {
      job_id:   jobId,
      symbol:   trade.symbol,
      side:     trade.side,
      quantity: trade.quantity,
      price:    trade.price,
    });

    await client.query(
      `INSERT INTO holdings (portfolio_id, symbol, quantity, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (portfolio_id, symbol)
       DO UPDATE SET quantity = $3, updated_at = NOW()`,
      [portfolioId, trade.symbol, trade.newQuantity]
    );
  }

  await client.query(
    `UPDATE portfolios SET cash_balance = $1 WHERE id = $2`,
    [newCashBalance.toFixed(2), portfolioId]
  );

  return { trades };
}


async function runRebalanceJob(jobId, portfolioId) {
  const start  = Date.now();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await executeRebalance(client, jobId, portfolioId);

    await client.query('COMMIT');
    logger.debug('transaction_commit', { job_id: jobId, duration_ms: Date.now() - start });

    await pool.query(
      `UPDATE rebalance_jobs SET status = 'completed', completed_at = NOW() WHERE id = $1`,
      [jobId]
    );

    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('transaction_rollback', {
      job_id:       jobId,
      portfolio_id: portfolioId,
      error:        err.message,
      duration_ms:  Date.now() - start,
    });

    await pool.query(
      `UPDATE rebalance_jobs SET status = 'failed', error_message = $1, completed_at = NOW() WHERE id = $2`,
      [err.message, jobId]
    );

    throw err;
  } finally {
    client.release();
  }
}

module.exports = { runRebalanceJob, calculateTrades };
