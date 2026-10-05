import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount, splitAmount, NNBSP, percentOf, formatBudget } from '@shared/money';

describe('formatAmount', () => {
  it('formats with NNBSP thousands and two decimals', () => {
    expect(formatAmount(128460)).toBe(`1${NNBSP}284.60`);
    expect(formatAmount(450)).toBe('4.50');
    expect(formatAmount(0)).toBe('0.00');
    expect(formatAmount(123456789)).toBe(`1${NNBSP}234${NNBSP}567.89`);
  });
  it('drops decimals only when asked and whole', () => {
    expect(formatAmount(200000, { decimals: false })).toBe(`2${NNBSP}000`);
    expect(formatAmount(200050, { decimals: false })).toBe(`2${NNBSP}000.50`);
    expect(formatBudget(200000)).toBe(`2${NNBSP}000`);
  });
  it('splits the hero number', () => {
    expect(splitAmount(128460)).toEqual({ int: `1${NNBSP}284`, frac: '.60' });
  });
});

describe('parseAmount', () => {
  it('reads common inputs', () => {
    expect(parseAmount('12')).toBe(1200);
    expect(parseAmount('12.5')).toBe(1250);
    expect(parseAmount('12,50')).toBe(1250);
    expect(parseAmount(`1${NNBSP}284.60`)).toBe(128460);
    expect(parseAmount("1'284.60")).toBe(128460);
    expect(parseAmount('CHF 4.50')).toBe(450);
    expect(parseAmount('4.50 chf')).toBe(450);
    expect(parseAmount('1.284,60')).toBe(128460);
    expect(parseAmount('4.5')).toBe(450);
    expect(parseAmount('0,99')).toBe(99);
  });
  it('reads a lone separator before three digits as thousands', () => {
    expect(parseAmount('1,000')).toBe(100000);
    expect(parseAmount('2,500')).toBe(250000);
    expect(parseAmount('12.000')).toBe(1200000);
    expect(parseAmount('100,000')).toBe(10000000);
    expect(parseAmount('CHF 2,500')).toBe(250000);
    expect(parseAmount('1,000.50')).toBe(100050);
    expect(parseAmount('1.000,50')).toBe(100050);
  });
  it('keeps decimals that are not a thousands group', () => {
    expect(parseAmount('0,500')).toBe(50); // a leading zero is a fraction
    expect(parseAmount('0.250')).toBe(25);
    expect(parseAmount('1,0000')).toBe(100); // four digits after the separator
    expect(parseAmount('1234,567')).toBe(123457); // four digits before it
    expect(parseAmount('.500')).toBe(50);
  });
  it('rejects nonsense', () => {
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('abc')).toBeNull();
    expect(parseAmount('-5')).toBeNull();
  });
});

describe('percentOf', () => {
  it('rounds and guards zero', () => {
    expect(percentOf(128460, 200000)).toBe(64);
    expect(percentOf(1, 0)).toBe(0);
  });
});
