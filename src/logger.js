// Structured JSON logger. One JSON object per line to stdout (errors to stderr).
// Control verbosity with LOG_LEVEL env var: error|warn|info|debug. Default: info.

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const configured   = process.env.LOG_LEVEL || 'info';
const currentLevel = LEVELS[configured] ?? LEVELS.info;

function log(level, msg, data = {}) {
  if (LEVELS[level] > currentLevel) return;

  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...data,
  });

  // Errors to stderr so they can be routed separately by Docker or a process manager.
  if (level === 'error') {
    process.stderr.write(entry + '\n');
  } else {
    process.stdout.write(entry + '\n');
  }
}

module.exports = {
  error: (msg, data) => log('error', msg, data),
  warn:  (msg, data) => log('warn',  msg, data),
  info:  (msg, data) => log('info',  msg, data),
  debug: (msg, data) => log('debug', msg, data),
};
