import { describe, expect, it } from 'vitest';
import { keyboardInset } from '@app/lib/native-feel';

describe('keyboardInset', () => {
  it('is zero when the visual viewport fills the layout viewport', () => {
    expect(keyboardInset(844, 844, 0)).toBe(0);
  });
  it('is the keyboard height when the visual viewport shrinks (iOS)', () => {
    expect(keyboardInset(844, 508, 0)).toBe(336);
  });
  it('accounts for the layout viewport having been scrolled under the keyboard', () => {
    expect(keyboardInset(844, 508, 100)).toBe(236);
    expect(keyboardInset(844, 508, 400)).toBe(0);
  });
  it('rounds to whole pixels and never goes negative', () => {
    expect(keyboardInset(844, 843.6, 0)).toBe(0);
    expect(keyboardInset(844, 500.4, 0)).toBe(344);
  });
});
