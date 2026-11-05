/**
 * Centralized error handling utility.
 *
 * Provides structured error handling with:
 * - Failure classification (expected, best-effort, recoverable, critical)
 * - Contextual logging (operation, entity ID, job ID, error)
 * - Stack trace preservation
 * - Retryable vs non-retryable error definitions
 */

/**
 * Error severity levels
 */
export enum ErrorSeverity {
  /** Expected failure: operation that can legitimately fail without indicating a problem */
  EXPECTED = 'expected',
  /** Best-effort operation: nice-to-have, should log but not crash */
  BEST_EFFORT = 'best_effort',
  /** Recoverable failure: should be retried with backoff */
  RECOVERABLE = 'recoverable',
  /** Critical failure: should propagate and alert */
  CRITICAL = 'critical',
}

/**
 * Error context for logging
 */
export interface ErrorContext {
  /** The operation being performed (e.g., 'fillField', 'submitApplication') */
  operation: string;
  /** Entity ID (e.g., applicationId, leadId, profileId) */
  entityId?: string;
  /** Job ID if applicable */
  jobId?: string;
  /** Additional context data */
  metadata?: Record<string, unknown>;
}

/**
 * Structured error class with context
 */
export class AppError extends Error {
  public readonly severity: ErrorSeverity;
  public readonly context: ErrorContext;
  public readonly retryable: boolean;
  public readonly cause?: Error;
  public readonly timestamp: Date;

  constructor(
    message: string,
    severity: ErrorSeverity,
    context: ErrorContext,
    retryable: boolean = false,
    cause?: Error,
  ) {
    super(message);
    this.name = 'AppError';
    this.severity = severity;
    this.context = context;
    this.retryable = retryable;
    this.cause = cause;
    this.timestamp = new Date();

    // Preserve stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AppError);
    }
  }

  /**
   * Get a formatted log message with context
   */
  toLogMessage(): string {
    const parts = [
      `[${this.severity.toUpperCase()}]`,
      this.context.operation,
    ];

    if (this.context.entityId) {
      parts.push(`entity=${this.context.entityId}`);
    }

    if (this.context.jobId) {
      parts.push(`job=${this.context.jobId}`);
    }

    parts.push(this.message);

    return parts.join(' ');
  }
}

/**
 * Critical error that should never be silently caught
 */
export class CriticalError extends AppError {
  constructor(message: string, context: ErrorContext, cause?: Error) {
    super(message, ErrorSeverity.CRITICAL, context, false, cause);
    this.name = 'CriticalError';
  }
}

/**
 * Recoverable error that should be retried
 */
export class RecoverableError extends AppError {
  constructor(message: string, context: ErrorContext, cause?: Error) {
    super(message, ErrorSeverity.RECOVERABLE, context, true, cause);
    this.name = 'RecoverableError';
  }
}

/**
 * Best-effort error - log but don't crash
 */
export class BestEffortError extends AppError {
  constructor(message: string, context: ErrorContext, cause?: Error) {
    super(message, ErrorSeverity.BEST_EFFORT, context, false, cause);
    this.name = 'BestEffortError';
  }
}

/**
 * Expected error - legitimate failure mode
 */
export class ExpectedError extends AppError {
  constructor(message: string, context: ErrorContext, cause?: Error) {
    super(message, ErrorSeverity.EXPECTED, context, false, cause);
    this.name = 'ExpectedError';
  }
}

/**
 * Handle errors based on severity
 */
export function handleError(err: unknown, context: ErrorContext): void {
  // If it's already an AppError, just log it
  if (err instanceof AppError) {
    logError(err);
    return;
  }

  // Convert unknown errors to AppError
  const error = err instanceof Error ? err : new Error(String(err));
  const appError = new AppError(
    error.message,
    determineSeverity(error, context),
    context,
    isRetryable(error),
    error,
  );

  logError(appError);

  // Critical errors should be re-thrown
  if (appError.severity === ErrorSeverity.CRITICAL) {
    throw appError;
  }
}

/**
 * Log error with appropriate level based on severity
 */
function logError(error: AppError): void {
  const message = error.toLogMessage();

  switch (error.severity) {
    case ErrorSeverity.CRITICAL:
      console.error(message);
      if (error.cause) {
        console.error('Caused by:', error.cause);
      }
      if (error.stack) {
        console.error('Stack trace:', error.stack);
      }
      break;

    case ErrorSeverity.RECOVERABLE:
      console.warn(message);
      if (error.cause) {
        console.warn('Caused by:', error.cause.message);
      }
      break;

    case ErrorSeverity.BEST_EFFORT:
      console.info(message);
      break;

    case ErrorSeverity.EXPECTED:
      console.debug(message);
      break;
  }
}

/**
 * Determine error severity based on error type and context
 */
function determineSeverity(error: Error, context: ErrorContext): ErrorSeverity {
  // Network/rate limit errors are recoverable
  if (isNetworkError(error) || isRateLimitError(error)) {
    return ErrorSeverity.RECOVERABLE;
  }

  // Database connection errors are critical
  if (isDatabaseError(error)) {
    return ErrorSeverity.CRITICAL;
  }

  // Validation errors are expected
  if (isValidationError(error)) {
    return ErrorSeverity.EXPECTED;
  }

  // Default to best-effort for unknown errors in non-critical operations
  // Critical operations should explicitly throw CriticalError
  return ErrorSeverity.BEST_EFFORT;
}

/**
 * Check if error is retryable
 */
function isRetryable(error: Error): boolean {
  // Rate limits are retryable
  if (isRateLimitError(error)) {
    return true;
  }

  // Network timeouts are retryable
  if (isNetworkError(error)) {
    return true;
  }

  // Temporary database errors (deadlocks, connection issues) are retryable
  if (isTemporaryDatabaseError(error)) {
    return true;
  }

  return false;
}

/**
 * Check if error is a network error
 */
function isNetworkError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes('network') ||
    message.includes('timeout') ||
    message.includes('fetch') ||
    message.includes('ECONNREFUSED') ||
    message.includes('ETIMEDOUT') ||
    message.includes('ENOTFOUND')
  );
}

/**
 * Check if error is a rate limit error
 */
function isRateLimitError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes('rate limit') ||
    message.includes('429') ||
    message.includes('quota') ||
    message.includes('too many requests')
  );
}

/**
 * Check if error is a database error
 */
function isDatabaseError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes('database') ||
    message.includes('prisma') ||
    message.includes('connection') ||
    message.includes('ECONNREFUSED') ||
    error.name.includes('Prisma')
  );
}

/**
 * Check if error is a temporary database error (retryable)
 */
function isTemporaryDatabaseError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes('deadlock') ||
    message.includes('connection timeout') ||
    message.includes('lock wait timeout')
  );
}

/**
 * Check if error is a validation error
 */
function isValidationError(error: Error): boolean {
  return (
    error.name === 'ZodError' ||
    error.message.toLowerCase().includes('validation') ||
    error.message.toLowerCase().includes('invalid')
  );
}

/**
 * Wrap a promise with error handling
 *
 * @example
 * ```ts
 * await withErrorHandling(
 *   async () => {
 *     await someOperation();
 *   },
 *   { operation: 'fillField', entityId: applicationId }
 * );
 * ```
 */
export async function withErrorHandling<T>(
  fn: () => Promise<T>,
  context: ErrorContext,
  options?: { severity?: ErrorSeverity; rethrow?: boolean },
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));

    // Use specified severity or auto-determine
    const severity = options?.severity ?? determineSeverity(error, context);
    const retryable = isRetryable(error);

    const appError = new AppError(
      error.message,
      severity,
      context,
      retryable,
      error,
    );

    logError(appError);

    if (options?.rethrow || severity === ErrorSeverity.CRITICAL) {
      throw appError;
    }

    // Re-throw original error for type safety
    throw error;
  }
}

/**
 * Execute a best-effort operation - logs errors but never throws
 *
 * @example
 * ```ts
 * await bestEffort(
 *   async () => {
 *     await markLeadProcessing(applicationId);
 *   },
 *   { operation: 'markLeadProcessing', entityId: applicationId }
 * );
 * ```
 */
export async function bestEffort<T>(
  fn: () => Promise<T>,
  context: ErrorContext,
): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const appError = new BestEffortError(error.message, context, error);
    logError(appError);
    return null;
  }
}

/**
 * Execute an expected operation - may legitimately fail
 *
 * @example
 * ```ts
 * const result = await expected(
 *   async () => {
 *     return await assessFit({ ...args, job });
 *   },
 *   { operation: 'assessFit', jobId: job.id }
 * );
 * ```
 */
export async function expected<T>(
  fn: () => Promise<T>,
  context: ErrorContext,
): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const appError = new ExpectedError(error.message, context, error);
    logError(appError);
    return null;
  }
}

/**
 * Execute a critical operation - throws on any error
 *
 * @example
 * ```ts
 * await critical(
 *   async () => {
 *     await prisma.$connect();
 *   },
 *   { operation: 'databaseConnect' }
 * );
 * ```
 */
export async function critical<T>(
  fn: () => Promise<T>,
  context: ErrorContext,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const appError = new CriticalError(error.message, context, error);
    logError(appError);
    throw appError;
  }
}
