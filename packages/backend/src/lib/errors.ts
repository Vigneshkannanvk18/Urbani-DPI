/**
 * Application error taxonomy (Task 1.4).
 *
 * All thrown errors that reach the API boundary are normalized into a stable
 * { error: { code, message, details, correlationId } } body by the error handler.
 */

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** 400 — request failed schema/validation. */
export class ValidationError extends AppError {
  constructor(message = 'Validation failed', details?: unknown) {
    super('VALIDATION_ERROR', message, 400, details);
  }
}

/** 401 — missing/invalid credentials or token. */
export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super('UNAUTHORIZED', message, 401);
  }
}

/** 403 — authenticated but not permitted. */
export class ForbiddenError extends AppError {
  constructor(message = 'Insufficient permissions') {
    super('FORBIDDEN', message, 403);
  }
}

/** 404 — resource not found. */
export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super('NOT_FOUND', message, 404);
  }
}

/**
 * 502 — a downstream integration (CloudWatch/Bedrock/DynamoDB/Urbani app) failed.
 * Kept distinct so the dashboard can surface "integration error" states clearly.
 */
export class IntegrationError extends AppError {
  constructor(message = 'Integration failure', details?: unknown) {
    super('INTEGRATION_ERROR', message, 502, details);
  }
}
