import { describe, expect, it } from 'vitest';
import { en } from '@app/i18n/en';
import { fr } from '@app/i18n/fr';
import { localeOf, resolveLanguage, translate } from '@app/i18n';

const NNBSP = ' ';
const keys = (d: Record<string, string>) => Object.keys(d).sort();
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('dictionaries', () => {
  it('EN and FR have exactly the same keys', () => {
    expect(keys(fr)).toEqual(keys(en));
  });

  it('no string is empty and both languages use the same {placeholders}', () => {
    for (const key of keys(en)) {
      const e = en[key as keyof typeof en];
      const f = fr[key as keyof typeof fr];
      expect(e.trim(), key).not.toBe('');
      expect(f.trim(), key).not.toBe('');
      expect(placeholders(f), key).toEqual(placeholders(e));
    }
  });

  it('plural keys come in _one / _other pairs with a {count}', () => {
    for (const key of keys(en)) {
      const m = /^(.*)_(one|other)$/.exec(key);
      if (!m) continue;
      const twin = `${m[1]}_${m[2] === 'one' ? 'other' : 'one'}`;
      expect(keys(en), key).toContain(twin);
      expect(en[key as keyof typeof en], key).toContain('{count}');
      expect(fr[key as keyof typeof fr], key).toContain('{count}');
    }
  });

  it('French puts a narrow no-break space before : ? ! % and inside « »', () => {
    for (const [key, value] of Object.entries(fr)) {
      for (const m of value.matchAll(/[:?!%»]/g)) {
        const i = m.index ?? 0;
        // "{time}"-style placeholders never sit right before punctuation; digits would be a clock time.
        if (i === 0 || /\d/.test(value[i - 1] ?? '')) continue;
        expect(value[i - 1], `${key}: "${value}"`).toBe(NNBSP);
      }
      for (const m of value.matchAll(/«/g)) expect(value[(m.index ?? 0) + 1], `${key}: "${value}"`).toBe(NNBSP);
      expect(value, key).not.toMatch(/[  ][:?!%»]/);
    }
  });

  it('English has no French spacing before punctuation', () => {
    for (const [key, value] of Object.entries(en)) expect(value, key).not.toMatch(/[   ][:?!%]/);
  });
});

describe('translate', () => {
  it('fills parameters', () => {
    expect(translate('en', 'home.ofBudget', { pct: 64, budget: '2 000' })).toBe('64% of 2 000');
    expect(translate('fr', 'home.ofBudget', { pct: 64, budget: '2 000' })).toBe(`64${NNBSP}% de 2 000`);
  });

  it('picks the plural form of each language', () => {
    expect(translate('en', 'home.daysLeft', { count: 1 })).toBe('1 day left');
    expect(translate('en', 'home.daysLeft', { count: 0 })).toBe('0 days left');
    expect(translate('en', 'capture.log', { count: 3 })).toBe('Log 3 entries');
    // French: 0 and 1 are singular.
    expect(translate('fr', 'home.daysLeft', { count: 0 })).toBe('0 jour restant');
    expect(translate('fr', 'home.daysLeft', { count: 1 })).toBe('1 jour restant');
    expect(translate('fr', 'home.daysLeft', { count: 26 })).toBe('26 jours restants');
  });

  it('leaves unknown placeholders visible', () => {
    expect(translate('en', 'key.ok', {})).toBe('Key works · {model}');
  });
});

describe('resolveLanguage', () => {
  it('auto follows the device: French when any preferred language is French', () => {
    expect(resolveLanguage('auto', ['de-CH', 'fr-CH', 'en'])).toBe('fr');
    expect(resolveLanguage('auto', ['en-GB', 'de'])).toBe('en');
    expect(resolveLanguage('auto', [])).toBe('en');
  });

  it('an explicit choice wins', () => {
    expect(resolveLanguage('en', ['fr-FR'])).toBe('en');
    expect(resolveLanguage('fr', ['en-US'])).toBe('fr');
  });

  it('dates use Swiss locales in both languages', () => {
    expect(localeOf('en')).toBe('en-CH');
    expect(localeOf('fr')).toBe('fr-CH');
  });
});
