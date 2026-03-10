import { describe, it, expect } from 'vitest';
import { toCamelCase, stripNotGiven } from '../src/util.js';

describe('toCamelCase', () => {
  it('converts snake_case to camelCase', () => {
    expect(toCamelCase('account_id')).toBe('accountId');
  });

  it('converts multi-segment snake_case', () => {
    expect(toCamelCase('status_callback_event')).toBe('statusCallbackEvent');
  });

  it('strips trailing underscore (reserved word escape)', () => {
    expect(toCamelCase('from_')).toBe('from');
  });

  it('returns single word unchanged', () => {
    expect(toCamelCase('hello')).toBe('hello');
  });

  it('handles single character segments', () => {
    expect(toCamelCase('a_b_c')).toBe('aBC');
  });

  it('returns empty string for empty input', () => {
    expect(toCamelCase('')).toBe('');
  });

  it('handles already camelCase input (no underscores)', () => {
    expect(toCamelCase('accountId')).toBe('accountId');
  });
});

describe('stripNotGiven', () => {
  it('removes null values', () => {
    const result = stripNotGiven({ a: 1, b: null });
    expect(result).toEqual({ a: 1 });
  });

  it('removes undefined values', () => {
    const result = stripNotGiven({ a: 'hello', b: undefined });
    expect(result).toEqual({ a: 'hello' });
  });

  it('keeps falsy values like 0, empty string, and false', () => {
    const result = stripNotGiven({ a: 0, b: '', c: false });
    expect(result).toEqual({ a: 0, b: '', c: false });
  });

  it('returns empty object when all values are null/undefined', () => {
    const result = stripNotGiven({ a: null, b: undefined });
    expect(result).toEqual({});
  });

  it('returns same object shape when no null/undefined values', () => {
    const input = { x: 1, y: 'test', z: true };
    const result = stripNotGiven(input);
    expect(result).toEqual(input);
  });

  it('handles empty object', () => {
    const result = stripNotGiven({});
    expect(result).toEqual({});
  });

  it('handles mixed values with some null and some undefined', () => {
    const result = stripNotGiven({
      keep: 'yes',
      removeNull: null,
      removeUndef: undefined,
      keepZero: 0,
    });
    expect(result).toEqual({ keep: 'yes', keepZero: 0 });
  });
});
