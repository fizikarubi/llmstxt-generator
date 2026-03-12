import { describe, it, expect } from 'vitest';
import { AppError, getErrorMessage, getErrorStatus } from '../errors';

describe('AppError', () => {
  it('creates an error with message and status', () => {
    const err = new AppError('Not found', 404);
    expect(err.message).toBe('Not found');
    expect(err.status).toBe(404);
    expect(err).toBeInstanceOf(Error);
  });

  it('defaults status to 500', () => {
    const err = new AppError('Something broke');
    expect(err.status).toBe(500);
  });
});

describe('getErrorMessage', () => {
  it('returns message from Error instances', () => {
    expect(getErrorMessage(new Error('oops'))).toBe('oops');
  });

  it('returns message from AppError instances', () => {
    expect(getErrorMessage(new AppError('bad request', 400))).toBe('bad request');
  });

  it('returns string errors directly', () => {
    expect(getErrorMessage('raw string')).toBe('raw string');
  });

  it('stringifies objects', () => {
    expect(getErrorMessage({ code: 42 })).toBe('{"code":42}');
  });

  it('handles null', () => {
    expect(getErrorMessage(null)).toBe('null');
  });

  it('handles undefined', () => {
    // JSON.stringify(undefined) returns undefined, then ?? kicks in
    expect(getErrorMessage(undefined)).toBe('unknown error');
  });
});

describe('getErrorStatus', () => {
  it('returns status from AppError', () => {
    expect(getErrorStatus(new AppError('x', 403))).toBe(403);
  });

  it('returns status from plain objects with status field', () => {
    expect(getErrorStatus({ status: 422 })).toBe(422);
  });

  it('defaults to 500 for plain errors', () => {
    expect(getErrorStatus(new Error('x'))).toBe(500);
  });

  it('defaults to 500 for null', () => {
    expect(getErrorStatus(null)).toBe(500);
  });

  it('defaults to 500 for strings', () => {
    expect(getErrorStatus('error')).toBe(500);
  });

  it('defaults to 500 when status is not a number', () => {
    expect(getErrorStatus({ status: 'bad' })).toBe(500);
  });
});
