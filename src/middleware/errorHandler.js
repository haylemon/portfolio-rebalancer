const logger = require('../logger');

function errorHandler(err, req, res, next) {
  // Log the full stack trace at error level.
  // In production, this goes to stderr and gets picked up by log aggregation.
  logger.error('unhandled_error', {
    request_id: req.requestId,
    method:     req.method,
    path:       req.path,
    error:      err.message,
    stack:      err.stack,
  });

  const statusCode = err.statusCode || 500;
  const message = process.env.NODE_ENV === 'production'
    ? 'Internal server error'
    : err.message;

  res.status(statusCode).json({ error: message });
}

module.exports = errorHandler;
