const logger = require('../logger');

function requestLogger(req, res, next) {
  const start = Date.now();

  req.requestId = Math.random().toString(36).substring(2, 10);

  logger.debug('http_incoming', {
    request_id: req.requestId,
    method:     req.method,
    path:       req.path,
  });

  // 'finish' fires after the response is sent — log here to capture status code and duration.
  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error'
                : res.statusCode >= 400 ? 'warn'
                : 'info';

    logger[level]('http_request', {
      request_id:  req.requestId,
      method:      req.method,
      path:        req.path,
      status:      res.statusCode,
      duration_ms: duration,
    });
  });

  next();
}

module.exports = requestLogger;
