import { ApiError } from './errors.js';

// Small hand-rolled validator so the project has no schema-library dependency.
// Each rule is { field, type, required, enum, min }.
export const validateBody = (rules) => (req, _res, next) => {
  const details = [];
  const body = req.body ?? {};

  for (const rule of rules) {
    const value = body[rule.field];

    if (value === undefined || value === null || value === '') {
      if (rule.required) details.push(`${rule.field} is required`);
      continue;
    }
    if (rule.type === 'number' && typeof value !== 'number') {
      details.push(`${rule.field} must be a number`);
      continue;
    }
    if (rule.type === 'string' && typeof value !== 'string') {
      details.push(`${rule.field} must be a string`);
      continue;
    }
    if (rule.enum && !rule.enum.includes(value)) {
      details.push(`${rule.field} must be one of: ${rule.enum.join(', ')}`);
    }
    if (rule.min !== undefined && typeof value === 'number' && value < rule.min) {
      details.push(`${rule.field} must be at least ${rule.min}`);
    }
    if (rule.minLength !== undefined && typeof value === 'string' && value.length < rule.minLength) {
      details.push(`${rule.field} must be at least ${rule.minLength} characters`);
    }
  }

  if (details.length) return next(new ApiError(422, 'Validation failed', details));
  next();
};
