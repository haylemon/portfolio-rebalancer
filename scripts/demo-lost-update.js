// Demonstrates the lost update problem and why atomic SQL matters.
//
// Run with: node scripts/demo-lost-update.js
// Requires: DATABASE_URL in .env and a portfolio already created.
//
// Usage: node scripts/demo-lost-update.js <portfolio-id>

require('dotenv').config();
const pool = require('../src/db/pool');

const portfolioId = process.argv[2];
if (!portfolioId) {
  console.error('Usage: node scripts/demo-lost-update.js <portfolio-id>');
  process.exit(1);
}

// ---------------------------------------------------------------
// BROKEN: read-modify-write pattern
// This is what a naive implementation looks like.
// The bug: both connections read the same value before either writes.
// ---------------------------------------------------------------
async function depositBroken(label, amount) {
  // Step 1: read the current balance
  const { rows } = await pool.query(
    'SELECT cash_balance FROM portfolios WHERE id = $1',
    [portfolioId]
  );
  const current = parseFloat(rows[0].cash_balance);
  console.log(`  [${label}] Read cash_balance = $${current}`);

  // Simulate a small delay — in a real system this could be any
  // processing time between the read and the write.
  await new Promise(r => setTimeout(r, 50));

  // Step 2: compute the new value in application code
  const newBalance = current + amount;

  // Step 3: write back. If another deposit ran between step 1 and now,
  // that deposit's effect is overwritten here.
  await pool.query(
    'UPDATE portfolios SET cash_balance = $1 WHERE id = $2',
    [newBalance, portfolioId]
  );
  console.log(`  [${label}] Wrote cash_balance = $${newBalance}`);
}

// ---------------------------------------------------------------
// SAFE: atomic SQL expression
// The database evaluates cash_balance + $1 on the current row value
// at the moment the UPDATE executes — not on a value we read earlier.
// Two concurrent atomic updates cannot interfere with each other.
// ---------------------------------------------------------------
async function depositSafe(label, amount) {
  const { rows } = await pool.query(
    'UPDATE portfolios SET cash_balance = cash_balance + $1 WHERE id = $2 RETURNING cash_balance',
    [amount, portfolioId]
  );
  console.log(`  [${label}] Atomic update → cash_balance = $${rows[0].cash_balance}`);
}

async function getBalance() {
  const { rows } = await pool.query(
    'SELECT cash_balance FROM portfolios WHERE id = $1', [portfolioId]
  );
  return parseFloat(rows[0].cash_balance);
}

async function setBalance(amount) {
  await pool.query(
    'UPDATE portfolios SET cash_balance = $1 WHERE id = $2', [amount, portfolioId]
  );
}

async function run() {
  const startingBalance = 1000;
  const depositA = 500;
  const depositB = 300;
  const expectedFinal = startingBalance + depositA + depositB;

  // ---- BROKEN DEMO ----
  console.log('\n--- BROKEN: read-modify-write (race condition) ---');
  console.log(`Starting balance: $${startingBalance}`);
  console.log(`Deposit A: +$${depositA}, Deposit B: +$${depositB}`);
  console.log(`Expected final balance: $${expectedFinal}`);
  console.log('');

  await setBalance(startingBalance);

  // Fire both deposits concurrently with no coordination.
  // They both read $1000 before either writes back.
  await Promise.all([
    depositBroken('deposit-A', depositA),
    depositBroken('deposit-B', depositB),
  ]);

  const brokenResult = await getBalance();
  console.log('');
  console.log(`Actual final balance:   $${brokenResult}`);
  console.log(`Expected final balance: $${expectedFinal}`);
  console.log(brokenResult === expectedFinal
    ? '✓ Correct (got lucky with timing)'
    : `✗ LOST UPDATE — one deposit was silently discarded`
  );

  // ---- SAFE DEMO ----
  console.log('\n--- SAFE: atomic SQL expression ---');
  console.log(`Starting balance: $${startingBalance}`);
  console.log('');

  await setBalance(startingBalance);

  // Both updates run concurrently but each is a single atomic statement.
  // PostgreSQL serialises writes to the same row — one completes, then the other
  // reads and updates the already-updated value.
  await Promise.all([
    depositSafe('deposit-A', depositA),
    depositSafe('deposit-B', depositB),
  ]);

  const safeResult = await getBalance();
  console.log('');
  console.log(`Actual final balance:   $${safeResult}`);
  console.log(`Expected final balance: $${expectedFinal}`);
  console.log(safeResult === expectedFinal
    ? '✓ Correct — atomic SQL prevented the lost update'
    : '✗ Unexpected mismatch'
  );

  await pool.end();
}

run().catch(err => {
  console.error(err.message);
  process.exit(1);
});
