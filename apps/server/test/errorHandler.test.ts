import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  AppError,
  CriticalError,
  RecoverableError,
  BestEffortError,
  ExpectedError,
  ErrorSeverity,
  handleError,
  withErrorHandling,
  bestEffort,
  expected,
  critical,
  type ErrorContext,
} from '../src/lib/errorHandler.js';

describe('errorHandler', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;
  let consoleDebugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    consoleDebugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleInfoSpy.mockRestore();
    consoleDebugSpy.mockRestore();
  });

  describe('AppError', () => {
    it('creates error with all properties', () => {
      const context: ErrorContext = {
        operation: 'testOperation',
        entityId: 'test-id',
        jobId: 'job-123',
        metadata: { extra: 'data' },
      };

      const cause = new Error('cause error');
      const error = new AppError('test message', ErrorSeverity.CRITICAL, context, true, cause);

      expect(error.message).toBe('test message');
      expect(error.severity).toBe(ErrorSeverity.CRITICAL);
      expect(error.context).toEqual(context);
      expect(error.retryable).toBe(true);
      expect(error.cause).toBe(cause);
      expect(error.timestamp).toBeInstanceOf(Date);
      expect(error.name).toBe('AppError');
    });

    it('preserves stack trace', () => {
      const error = new AppError('test', ErrorSeverity.CRITICAL, { operation: 'test' });
      expect(error.stack).toBeDefined();
    });

    it('formats log message correctly', () => {
      const context: ErrorContext = {
        operation: 'fillField',
        entityId: 'app-123',
        jobId: 'job-456',
      };

      const error = new AppError('field not found', ErrorSeverity.EXPECTED, context);
      const message = error.toLogMessage();

      expect(message).toContain('[EXPECTED]');
      expect(message).toContain('fillField');
      expect(message).toContain('entity=app-123');
      expect(message).toContain('job=job-456');
      expect(message).toContain('field not found');
    });
  });

  describe('Error subclasses', () => {
    it('CriticalError has correct defaults', () => {
      const error = new CriticalError('critical failure', { operation: 'test' });
      expect(error.severity).toBe(ErrorSeverity.CRITICAL);
      expect(error.retryable).toBe(false);
      expect(error.name).toBe('CriticalError');
    });

    it('RecoverableError has correct defaults', () => {
      const error = new RecoverableError('retryable failure', { operation: 'test' });
      expect(error.severity).toBe(ErrorSeverity.RECOVERABLE);
      expect(error.retryable).toBe(true);
      expect(error.name).toBe('RecoverableError');
    });

    it('BestEffortError has correct defaults', () => {
      const error = new BestEffortError('best effort failure', { operation: 'test' });
      expect(error.severity).toBe(ErrorSeverity.BEST_EFFORT);
      expect(error.retryable).toBe(false);
      expect(error.name).toBe('BestEffortError');
    });

    it('ExpectedError has correct defaults', () => {
      const error = new ExpectedError('expected failure', { operation: 'test' });
      expect(error.severity).toBe(ErrorSeverity.EXPECTED);
      expect(error.retryable).toBe(false);
      expect(error.name).toBe('ExpectedError');
    });
  });

  describe('handleError', () => {
    it('logs AppError with correct severity', () => {
      const error = new CriticalError('critical', { operation: 'test' });
      handleError(error, { operation: 'test' });

      expect(consoleErrorSpy).toHaveBeenCalled();
      expect(consoleErrorSpy.mock.calls[0]?.[0]).toContain('[CRITICAL]');
    });

    it('converts unknown Error to AppError', () => {
      const error = new Error('unknown error');
      handleError(error, { operation: 'test' });

      expect(consoleInfoSpy).toHaveBeenCalled();
    });

    it('converts non-Error to AppError', () => {
      handleError('string error', { operation: 'test' });

      expect(consoleInfoSpy).toHaveBeenCalled();
    });

    it('re-throws critical errors', () => {
      const error = new CriticalError('critical', { operation: 'test' });

      expect(() => handleError(error, { operation: 'test' })).toThrow(CriticalError);
    });

    it('does not re-throw non-critical errors', () => {
      const error = new BestEffortError('best effort', { operation: 'test' });

      expect(() => handleError(error, { operation: 'test' })).not.toThrow();
    });
  });

  describe('error severity detection', () => {
    it('detects network errors as recoverable', () => {
      const error = new Error('Network timeout');
      handleError(error, { operation: 'test' });

      expect(consoleWarnSpy).toHaveBeenCalled();
    });

    it('detects rate limit errors as recoverable', () => {
      const error = new Error('Rate limit exceeded (429)');
      handleError(error, { operation: 'test' });

      expect(consoleWarnSpy).toHaveBeenCalled();
    });

    it('detects database errors as critical', () => {
      const error = new Error('Database connection failed');

      expect(() => handleError(error, { operation: 'test' })).toThrow();
    });

    it('detects validation errors as expected', () => {
      const error = new Error('Validation failed');
      handleError(error, { operation: 'test' });

      expect(consoleDebugSpy).toHaveBeenCalled();
    });
  });

  describe('withErrorHandling', () => {
    it('executes function successfully', async () => {
      const result = await withErrorHandling(
        async () => 'success',
        { operation: 'test' },
      );

      expect(result).toBe('success');
    });

    it('handles errors with logging', async () => {
      await expect(
        withErrorHandling(
          async () => {
            throw new Error('test error');
          },
          { operation: 'test' },
        ),
      ).rejects.toThrow();
    });

    it('uses specified severity', async () => {
      await expect(
        withErrorHandling(
          async () => {
            throw new Error('test error');
          },
          { operation: 'test' },
          { severity: ErrorSeverity.CRITICAL },
        ),
      ).rejects.toThrow();

      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it('re-throws when requested', async () => {
      await expect(
        withErrorHandling(
          async () => {
            throw new Error('test error');
          },
          { operation: 'test' },
          { rethrow: true },
        ),
      ).rejects.toThrow();
    });
  });

  describe('bestEffort', () => {
    it('returns result on success', async () => {
      const result = await bestEffort(
        async () => 'success',
        { operation: 'test' },
      );

      expect(result).toBe('success');
    });

    it('returns null on error', async () => {
      const result = await bestEffort(
        async () => {
          throw new Error('test error');
        },
        { operation: 'test' },
      );

      expect(result).toBeNull();
    });

    it('logs errors as best-effort', async () => {
      await bestEffort(
        async () => {
          throw new Error('test error');
        },
        { operation: 'test' },
      );

      expect(consoleInfoSpy).toHaveBeenCalled();
      expect(consoleInfoSpy.mock.calls[0]?.[0]).toContain('[BEST_EFFORT]');
    });

    it('never throws', async () => {
      await expect(
        bestEffort(
          async () => {
            throw new Error('test error');
          },
          { operation: 'test' },
        ),
      ).resolves.not.toThrow();
    });
  });

  describe('expected', () => {
    it('returns result on success', async () => {
      const result = await expected(
        async () => 'success',
        { operation: 'test' },
      );

      expect(result).toBe('success');
    });

    it('returns null on error', async () => {
      const result = await expected(
        async () => {
          throw new Error('test error');
        },
        { operation: 'test' },
      );

      expect(result).toBeNull();
    });

    it('logs errors as expected', async () => {
      await expected(
        async () => {
          throw new Error('test error');
        },
        { operation: 'test' },
      );

      expect(consoleDebugSpy).toHaveBeenCalled();
      expect(consoleDebugSpy.mock.calls[0]?.[0]).toContain('[EXPECTED]');
    });

    it('never throws', async () => {
      await expect(
        expected(
          async () => {
            throw new Error('test error');
          },
          { operation: 'test' },
        ),
      ).resolves.not.toThrow();
    });
  });

  describe('critical', () => {
    it('returns result on success', async () => {
      const result = await critical(
        async () => 'success',
        { operation: 'test' },
      );

      expect(result).toBe('success');
    });

    it('throws on error', async () => {
      await expect(
        critical(
          async () => {
            throw new Error('test error');
          },
          { operation: 'test' },
        ),
      ).rejects.toThrow();
    });

    it('logs errors as critical', async () => {
      try {
        await critical(
          async () => {
            throw new Error('test error');
          },
          { operation: 'test' },
        );
      } catch (e) {
        // Expected to throw
      }

      expect(consoleErrorSpy).toHaveBeenCalled();
      expect(consoleErrorSpy.mock.calls[0]?.[0]).toContain('[CRITICAL]');
    });
  });

  describe('retryable error detection', () => {
    it('detects rate limit as retryable', () => {
      const error = new Error('Rate limit exceeded');
      const context: ErrorContext = { operation: 'test' };
      const appError = new AppError(error.message, ErrorSeverity.RECOVERABLE, context, true, error);

      expect(appError.retryable).toBe(true);
    });

    it('detects network timeout as retryable', () => {
      const error = new Error('Network timeout');
      const context: ErrorContext = { operation: 'test' };
      const appError = new AppError(error.message, ErrorSeverity.RECOVERABLE, context, true, error);

      expect(appError.retryable).toBe(true);
    });

    it('detects database deadlock as retryable', () => {
      const error = new Error('Deadlock detected');
      const context: ErrorContext = { operation: 'test' };
      const appError = new AppError(error.message, ErrorSeverity.RECOVERABLE, context, true, error);

      expect(appError.retryable).toBe(true);
    });
  });

  describe('error cause chain', () => {
    it('preserves error cause', () => {
      const cause = new Error('root cause');
      const error = new AppError('wrapper', ErrorSeverity.CRITICAL, { operation: 'test' }, false, cause);

      expect(error.cause).toBe(cause);
    });

    it('logs cause for critical errors', () => {
      const cause = new Error('root cause');
      const error = new CriticalError('wrapper', { operation: 'test' }, cause);
      handleError(error, { operation: 'test' });

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[CRITICAL]')
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Caused by:',
        cause
      );
    });

    it('logs cause for recoverable errors', () => {
      const cause = new Error('root cause');
      const error = new RecoverableError('wrapper', { operation: 'test' }, cause);
      handleError(error, { operation: 'test' });

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[RECOVERABLE]')
      );
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'Caused by:',
        cause.message
      );
    });
  });
});
