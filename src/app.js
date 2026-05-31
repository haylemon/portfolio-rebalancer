require('dotenv').config();

const express       = require('express');
const logger        = require('./logger');
const requestLogger = require('./middleware/requestLogger');
const errorHandler  = require('./middleware/errorHandler');

const portfolioRoutes = require('./routes/portfolios');
const priceRoutes     = require('./routes/prices');
const jobRoutes       = require('./routes/jobs');

const app = express();

app.use(express.json());

// Request logger must come before routes so it wraps every request.
app.use(requestLogger);

app.get('/health', async (req, res) => {
  const pool = require('./db/pool');
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (err) {
    logger.error('health_check_failed', { error: err.message });
    res.status(503).json({ status: 'error', database: 'disconnected' });
  }
});

app.use('/portfolios', portfolioRoutes);
app.use('/prices',     priceRoutes);
app.use('/jobs',       jobRoutes);

// Error handler must be registered last.
app.use(errorHandler);

module.exports = app;
