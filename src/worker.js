const pool   = require('./db/pool');
const logger = require('./logger');
const { runRebalanceJob } = require('./rebalance');

const POLL_INTERVAL_MS        = 3000;
const STUCK_THRESHOLD_MINUTES = 10;
const MAX_ATTEMPTS            = 3;

// Claims one pending job and atomically marks it as 'processing'.
// FOR UPDATE SKIP LOCKED means two workers running simultaneously will never
// claim the same job — the second worker skips any row already locked.
async function claimNextJob() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(`
      SELECT id, portfolio_id
      FROM   rebalance_jobs
      WHERE  status = 'pending'
      ORDER  BY created_at ASC
      LIMIT  1
      FOR UPDATE SKIP LOCKED
    `);

    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    const job = rows[0];

    // Mark as processing while still holding the row lock — the SELECT and
    // UPDATE are atomic, so no other worker can claim this job between them.
    await client.query(
      `UPDATE rebalance_jobs
       SET    status     = 'processing',
              started_at = NOW(),
              attempts   = attempts + 1
       WHERE  id = $1`,
      [job.id]
    );

    await client.query('COMMIT');
    return job;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}


// Finds jobs stuck in 'processing' (from a crashed worker) and either
// requeues them for retry or permanently fails them if MAX_ATTEMPTS is reached.
async function recoverStuckJobs() {
  const { rows: recovered } = await pool.query(
    `UPDATE rebalance_jobs
     SET    status = 'pending'
     WHERE  status     = 'processing'
       AND  started_at < NOW() - INTERVAL '${STUCK_THRESHOLD_MINUTES} minutes'
       AND  attempts   < $1
     RETURNING id`,
    [MAX_ATTEMPTS]
  );

  const { rows: abandoned } = await pool.query(
    `UPDATE rebalance_jobs
     SET    status        = 'failed',
            error_message = 'Exceeded maximum retry attempts',
            completed_at  = NOW()
     WHERE  status     = 'processing'
       AND  started_at < NOW() - INTERVAL '${STUCK_THRESHOLD_MINUTES} minutes'
       AND  attempts   >= $1
     RETURNING id`,
    [MAX_ATTEMPTS]
  );

  if (recovered.length > 0) {
    logger.warn('jobs_recovered', { service: 'worker', count: recovered.length, job_ids: recovered.map(r => r.id) });
  }
  if (abandoned.length > 0) {
    logger.error('jobs_abandoned', { service: 'worker', count: abandoned.length, job_ids: abandoned.map(r => r.id), max_attempts: MAX_ATTEMPTS });
  }
}


async function tick() {
  await recoverStuckJobs();

  const job = await claimNextJob();
  if (!job) {
    logger.debug('worker_poll', { service: 'worker', result: 'no_pending_jobs' });
    return;
  }

  logger.info('job_claimed', { service: 'worker', job_id: job.id, portfolio_id: job.portfolio_id });

  const start = Date.now();
  try {
    await runRebalanceJob(job.id, job.portfolio_id);
    logger.info('job_completed', { service: 'worker', job_id: job.id, duration_ms: Date.now() - start });
  } catch (err) {
    logger.error('job_failed', { service: 'worker', job_id: job.id, error: err.message, duration_ms: Date.now() - start });
  }
}


async function startWorker() {
  logger.info('worker_started', {
    service:          'worker',
    poll_interval_ms: POLL_INTERVAL_MS,
    max_attempts:     MAX_ATTEMPTS,
    stuck_threshold:  `${STUCK_THRESHOLD_MINUTES}m`,
  });

  let running = true;

  process.on('SIGTERM', () => { logger.info('worker_shutdown', { service: 'worker', signal: 'SIGTERM' }); running = false; });
  process.on('SIGINT',  () => { logger.info('worker_shutdown', { service: 'worker', signal: 'SIGINT'  }); running = false; });

  // while loop + await instead of setInterval — setInterval doesn't wait for the
  // previous tick to finish, which could cause overlapping job processing.
  while (running) {
    try {
      await tick();
    } catch (err) {
      logger.error('worker_tick_error', { service: 'worker', error: err.message });
    }

    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  logger.info('worker_stopped', { service: 'worker' });
  await pool.end();
}

module.exports = { startWorker };
