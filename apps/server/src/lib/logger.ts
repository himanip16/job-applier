import pino from 'pino';
import { config } from './config.js';

/**
 * Redaction paths for sensitive information.
 *
 * These patterns match keys in log objects and replace their values with '[Redacted]'.
 */
const redactPaths = [
  // API keys and tokens
  'apiKey',
  'api_key',
  'apiSecret',
  'api_secret',
  'token',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'authToken',
  'auth_token',
  'bearer',
  'password',
  'secret',
  'privateKey',
  'private_key',
  'sessionToken',
  'session_token',

  // Personal data
  'email',
  'phone',
  'phoneNumber',
  'phone_number',
  'ssn',
  'socialSecurityNumber',
  'address',
  'fullAddress',
  'full_address',

  // Resume contents
  'resumeText',
  'resume_text',
  'resumeContent',
  'resume_content',
  'coverLetter',
  'cover_letter',

  // Config values that might contain secrets
  'config.anthropicApiKey',
  'config.geminiApiKey',
  'config.firecrawlApiKey',
  'config.resendApiKey',

  // Headers that might contain auth
  'headers.authorization',
  'headers.cookie',
  'headers["set-cookie"]',
  'headers["x-api-key"]',
];

/**
 * Base logger configuration.
 *
 * Uses JSON output in production, pretty-printed output in development.
 * All log levels are enabled (trace, debug, info, warn, error, fatal).
 */
const baseLogger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: redactPaths,
    remove: true,
  },
  formatters: {
    level: (label) => {
      return { level: label };
    },
  },
  serializers: {
    err: pino.stdSerializers.err,
    error: pino.stdSerializers.err,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * Development logger with pretty printing.
 */
const developmentLogger = pino({
  ...baseLogger,
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss Z',
      ignore: 'pid,hostname',
      singleLine: false,
    },
  },
});

/**
 * Production logger with JSON output.
 */
const productionLogger = baseLogger;

/**
 * Select the appropriate logger based on environment.
 */
const isDevelopment = process.env.NODE_ENV !== 'production';
const logger = isDevelopment ? developmentLogger : productionLogger;

/**
 * Create a child logger with additional context.
 *
 * @param context - Additional context to include in all log entries
 * @returns A child logger with the provided context
 */
export function createChildLogger(context: Record<string, unknown>) {
  return logger.child(context);
}

/**
 * Create a logger with request-scoped context.
 *
 * @param requestId - Unique identifier for the request
 * @param correlationId - Optional correlation ID for tracing across services
 * @param additionalContext - Additional context to include
 * @returns A child logger with request context
 */
export function createRequestLogger(
  requestId: string,
  correlationId?: string,
  additionalContext?: Record<string, unknown>,
) {
  const context: Record<string, unknown> = {
    requestId,
  };

  if (correlationId) {
    context.correlationId = correlationId;
  }

  if (additionalContext) {
    Object.assign(context, additionalContext);
  }

  return logger.child(context);
}

/**
 * Create a logger with application/job context.
 *
 * @param applicationId - Application identifier
 * @param jobId - Job identifier
 * @param company - Company name
 * @param source - Source/platform (e.g., 'linkedin', 'workday')
 * @returns A child logger with application context
 */
export function createApplicationLogger(
  applicationId?: string,
  jobId?: string,
  company?: string,
  source?: string,
) {
  const context: Record<string, unknown> = {};

  if (applicationId) {
    context.applicationId = applicationId;
  }

  if (jobId) {
    context.jobId = jobId;
  }

  if (company) {
    context.company = company;
  }

  if (source) {
    context.source = source;
  }

  return logger.child(context);
}

/**
 * Create a logger with profile context.
 *
 * @param profileId - Profile identifier
 * @param email - Profile email (will be redacted if sensitive)
 * @returns A child logger with profile context
 */
export function createProfileLogger(profileId?: string, email?: string) {
  const context: Record<string, unknown> = {};

  if (profileId) {
    context.profileId = profileId;
  }

  if (email) {
    context.email = email;
  }

  return logger.child(context);
}

/**
 * Export the base logger for direct use.
 * Prefer the create*Logger functions for context-aware logging.
 */
export { logger };

/**
 * Log levels for type safety.
 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
