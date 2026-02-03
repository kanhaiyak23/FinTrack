// Wraps an async route so a rejected promise reaches the central error handler
// instead of hanging the request. Controllers therefore contain no try/catch.
export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
