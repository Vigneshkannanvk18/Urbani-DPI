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

/**
 * 503 — a live integration is reachable-but-failing right now (transient). Used
 * by the live chat path so a failed /chat call surfaces a controlled, honest
 * "temporarily unavailable" response (never a 500, never a fabricated answer).
 */
export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service temporarily unavailable') {
    super('CHAT_UNAVAILABLE', message, 503);
  }
}

/**
 * Persistence-layer failure raised by both repository drivers (DPI 2 item 1).
 * Messages are generic; `details` only ever carries the zod issues of the caller's own input.
 */
export type PersistenceReason =
  | 'DUPLICATE' | 'REFERENCE_NOT_FOUND' | 'INVALID_ARGUMENT' | 'INVALID_CURSOR' | 'ITEM_TOO_LARGE' | 'UNAVAILABLE';
const PERSISTENCE_STATUS: Record<PersistenceReason, number> = {
  DUPLICATE: 409, REFERENCE_NOT_FOUND: 404, INVALID_ARGUMENT: 400, INVALID_CURSOR: 400, ITEM_TOO_LARGE: 500, UNAVAILABLE: 503,
};
export class PersistenceError extends AppError {
  readonly fatal: boolean;
  readonly awsErrorName?: string;          // e.g. 'ResourceNotFoundException'; never the raw message/item
  constructor(readonly reason: PersistenceReason, message: string,
              opts: { details?: unknown; fatal?: boolean; awsErrorName?: string } = {}) {
    super(`PERSISTENCE_${reason}`, message, PERSISTENCE_STATUS[reason], opts.details);
    this.fatal = opts.fatal ?? false;
    this.awsErrorName = opts.awsErrorName;
  }
}
