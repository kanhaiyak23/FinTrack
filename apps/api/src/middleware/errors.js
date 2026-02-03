import { logger } from '../config/logger.js';
import { config } from '../config/index.js';

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }

  static badRequest(message, details) { return new ApiError(400, message, details); }
  static unauthorized(message = 'Authentication required') { return new ApiError(401, message); }
  static forbidden(message = 'Not permitted') { return new ApiError(403, message); }
  static notFound(message = 'Resource not found') { return new ApiError(404, message); }
  static conflict(message, details) { return new ApiError(409, message, details); }
  static validation(message, details) { return new ApiError(422, message, details); }
}

export const notFound = (req, _res, next) => {
  next(ApiError.notFound(`No route for ${req.method} ${req.originalUrl}`));
};

// Four parameters are required for Express to recognise this as an error handler.
export const errorHandler = (err, req, res, _next) => {
  const status = err.status ?? 500;

  if (status >= 500) {
    logger.error({ err, requestId: req.id, path: req.originalUrl }, 'unhandled error');
  } else {
    logger.warn({ requestId: req.id, status, message: err.message }, 'request rejected');
  }

  res.status(status).json({
    error: {
      // Internal failures never leak their message or stack to the client.
      message: status >= 500 ? 'Internal server error' : err.message,
      ...(err.details ? { details: err.details } : {}),
      requestId: req.id,
      ...(status >= 500 && !config.isProduction ? { debug: err.message } : {}),
    },
  });
};
