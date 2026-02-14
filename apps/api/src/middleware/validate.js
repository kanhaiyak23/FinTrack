import { ApiError } from './errors.js';

// Validates and REPLACES the request part with the parsed result, so controllers
// receive coerced, stripped data rather than raw input. Unknown keys are dropped by
// zod's default object behaviour, which is what stops a client from smuggling fields.
const validate = (source) => (schema) => (req, _res, next) => {
  const result = schema.safeParse(req[source]);

  if (!result.success) {
    const details = result.error.issues.map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    });
    return next(ApiError.validation('Validation failed', details));
  }

  // req.query is a getter on newer Express; assign to a own-property shadow instead.
  Object.defineProperty(req, source, { value: result.data, writable: true, configurable: true });
  next();
};

export const validateBody = validate('body');
export const validateQuery = validate('query');
export const validateParams = validate('params');
