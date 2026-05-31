# Portfolio Rebalancer

A backend service that automatically rebalances investment portfolios using PostgreSQL, Node.js, and a background job queue.

## What it demonstrates

- **Atomic transactions** — rebalance writes (trades, holdings, cash) commit together or not at all
- **Row-level locking** — `FOR UPDATE` prevents concurrent rebalances from corrupting portfolio state
- **Database-enforced constraints** — a partial unique index guarantees one active job per portfolio, which no application-level check can safely do
- **Async job processing** — API queues work immediately, a background worker processes it with crash recovery and retry logic

## How to run it

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env` and add your database URL
3. Run migrations: `node scripts/migrate.js`
4. Start the API: `node server.js`
5. Start the worker: `node worker.js`

## Tech stack

- Node.js + Express
- PostgreSQL
- No external queue — the job queue is a database table
