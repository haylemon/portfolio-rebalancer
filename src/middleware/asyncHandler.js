// Wraps an async route handler so thrown errors are passed to Express's next()
// instead of becoming unhandled promise rejections.
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;
