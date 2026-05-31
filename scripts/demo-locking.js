// Demonstrates FOR UPDATE row locking.
// Connection A holds a lock on a portfolio row for several seconds.
// Connection B tries to update the same row and blocks until A releases.
//
// Run with: node scripts/demo-locking.js <portfolio-id>
// Watch the timestamps — you can see exactly when B unblocks.

require('dotenv').config();
const pool = require('../src/db/pool');

const portfolioId = process.argv[2];
if (!portfolioId) {
  console.error('Usage: node scripts/demo-locking.js <portfolio-id>');
  process.exit(1);
}

function timestamp() {
  return new Date().toISOString().substring(11, 23); // HH:MM:SS.mmm
}

async function connectionA() {
  const client = await pool.connect();
  try {
    console.log(`[${timestamp()}] [conn-A] BEGIN`);
    await client.query('BEGIN');

    // This is what the rebalance worker does: lock the portfolio row.
    // Any other transaction trying to UPDATE or SELECT FOR UPDATE on this
    // row will now block until we COMMIT or ROLLBACK.
    const { rows } = await client.query(
      'SELECT id, cash_balance FROM portfolios WHERE id = $1 FOR UPDATE',
      [portfolioId]
    );
    console.log(`[${timestamp()}] [conn-A] Locked portfolio row (cash_balance = $${rows[0].cash_balance})`);
    console.log(`[${timestamp()}] [conn-A] Simulating slow rebalance — holding lock for 4 seconds...`);

    await new Promise(r => setTimeout(r, 4000));

    // Update cash balance as if we completed a rebalance.
    await client.query(
      'UPDATE portfolios SET cash_balance = cash_balance - 100 WHERE id = $1',
      [portfolioId]
    );
    console.log(`[${timestamp()}] [conn-A] Rebalance complete, releasing lock (COMMIT)`);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

async function connectionB() {
  // Wait briefly so A gets the lock first.
  await new Promise(r => setTimeout(r, 500));

  const client = await pool.connect();
  try {
    console.log(`[${timestamp()}] [conn-B] Attempting to deposit $200...`);

    // This UPDATE targets the same row that A has locked.
    // It will block here until A commits. You can observe the delay.
    //
    // In our system this is what happens when a deposit request arrives
    // while a rebalance transaction is holding the portfolio lock.
    // The deposit does not fail — it waits and then succeeds with the
    // correct post-rebalance balance as the starting point.
    await client.query(
      'UPDATE portfolios SET cash_balance = cash_balance + 200 WHERE id = $1',
      [portfolioId]
    );
    console.log(`[${timestamp()}] [conn-B] Deposit succeeded — lock was released by conn-A`);
  } finally {
    client.release();
  }
}

async function showLocks() {
  // Poll pg_locks to show the blocked connection in real time.
  await new Promise(r => setTimeout(r, 1000));

  const { rows } = await pool.query(`
    SELECT
      pid,
      granted,
      mode,
      relation::regclass AS table_name
    FROM pg_locks
    WHERE relation::regclass::text = 'portfolios'
      AND pid != pg_backend_pid()
  `);

  if (rows.length > 0) {
    console.log(`\n[${timestamp()}] [pg_locks] Active locks on portfolios table:`);
    rows.forEach(r => {
      const state = r.granted ? 'GRANTED' : 'WAITING';
      console.log(`  PID ${r.pid}: ${r.mode} — ${state}`);
    });
    console.log('');
  }
}

async function run() {
  console.log('--- FOR UPDATE locking demo ---\n');
  console.log('conn-A = simulated rebalance transaction (holds lock for 4 seconds)');
  console.log('conn-B = concurrent deposit request (will block until A releases)\n');

  await Promise.all([
    connectionA(),
    connectionB(),
    showLocks(),
  ]);

  // Show final state.
  const { rows } = await pool.query(
    'SELECT cash_balance FROM portfolios WHERE id = $1', [portfolioId]
  );
  console.log(`\n[${timestamp()}] Final cash_balance: $${rows[0].cash_balance}`);
  console.log('Both operations applied correctly. No lost update.');

  await pool.end();
}

run().catch(err => {
  console.error(err.message);
  process.exit(1);
});
