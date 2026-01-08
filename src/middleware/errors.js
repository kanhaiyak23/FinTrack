export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const notFound = (req, res, next) => {
  next(new ApiError(404, `No route for ${req.method} ${req.originalUrl}`));
};

// Four arguments are required here for Express to treat this as an error handler.
export const errorHandler = (err, req, res, _next) => {
  const status = err.status ?? 500;
  if (status >= 500) console.error(err);
  res.status(status).json({
    error: {
      message: status >= 500 ? 'Internal server error' : err.message,
      ...(err.details ? { details: err.details } : {}),
    },
  });
};
