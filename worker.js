// Entry point for the background worker process.
// Run separately from the API server: node worker.js
// Both processes share the same PostgreSQL database.
require('dotenv').config();

const { startWorker } = require('./src/worker');

startWorker().catch((err) => {
  console.error('[worker] Fatal error:', err.message);
  process.exit(1);
});
