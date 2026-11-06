import { describe, expect, it } from 'vitest';
import { softLimitAllows } from '../../src/shared/usage';
import { localDateKey } from '../../src/shared/usage';
import { AppError } from '../../src/shared/errors';

describe('usage', () => {
  it('formats local date keys', () => {
    expect(localDateKey(new Date(2026, 0, 2, 23, 59))).toBe('2026-01-02');
  });

  it('allows when the limit is disabled', () => {
    expect(softLimitAllows(999_999, 10, null)).toEqual({
      allowed: true,
      used: 999_999,
      limit: null,
    });
    expect(softLimitAllows(999_999, 10, 0).allowed).toBe(true);
  });

  it('blocks once the soft limit would be exceeded', () => {
    expect(softLimitAllows(19_990, 10, 20_000).allowed).toBe(true);
    expect(softLimitAllows(19_991, 10, 20_000).allowed).toBe(false);
  });
});

describe('AppError', () => {
  it('maps errors to user-facing payloads with actions', () => {
    const error = new AppError('MODEL_NOT_READY');
    const payload = error.toPayload();
    expect(payload.code).toBe('MODEL_NOT_READY');
    expect(payload.action).toBe('prepare-model');
    expect(payload.retryable).toBe(true);
  });

  it('does not retry auth failures', () => {
    expect(new AppError('AUTH_FAILED').toPayload().retryable).toBe(false);
  });

  it('keeps diagnostics short and free of text', () => {
    const payload = new AppError('AUTH_FAILED', { diagnostic: 'HTTP 401' }).toPayload();
    expect(payload.diagnostic).toBe('HTTP 401');
  });
});
