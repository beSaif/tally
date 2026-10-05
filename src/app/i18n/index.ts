import { computed, signal } from '@preact/signals';
import type { Language, ResolvedLanguage } from '@shared/api';
import { en, type Dict, type DictKey } from './en';
import { fr } from './fr';

export type { Dict, DictKey };

export const dictionaries: Record<ResolvedLanguage, Dict> = { en, fr };

/** Plural pairs are addressed by their base name: `t('home.daysLeft', { count })`. */
type BaseKey<K extends string> = K extends `${infer B}_one` ? B : K extends `${infer B}_other` ? B : K;
export type TKey = BaseKey<DictKey>;
export type TParams = Record<string, string | number>;

function deviceLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  if (navigator.languages && navigator.languages.length) return navigator.languages;
  return navigator.language ? [navigator.language] : [];
}

/** `auto` follows the device: French when any preferred language is French, else English. */
export function resolveLanguage(pref: Language, languages: readonly string[] = deviceLanguages()): ResolvedLanguage {
  if (pref === 'en' || pref === 'fr') return pref;
  return languages.some((l) => l.toLowerCase().startsWith('fr')) ? 'fr' : 'en';
}

/** The user's language preference (from settings, or a live preview while choosing it in setup). */
export const languagePref = signal<Language>('auto');
export const lang = computed<ResolvedLanguage>(() => resolveLanguage(languagePref.value));

const pluralRules: Partial<Record<ResolvedLanguage, Intl.PluralRules>> = {};
function pluralCategory(language: ResolvedLanguage, count: number): Intl.LDMLPluralRule {
  const rules = (pluralRules[language] ??= new Intl.PluralRules(language));
  return rules.select(count);
}

function lookup(dict: Dict, key: string): string | undefined {
  return (dict as Record<string, string>)[key];
}

/** Pure translation for a given language (used by tests and non-reactive code). */
export function translate(language: ResolvedLanguage, key: TKey, params?: TParams): string {
  const dict = dictionaries[language];
  let template: string | undefined;
  const count = params?.count;
  if (typeof count === 'number') {
    const category = pluralCategory(language, count);
    template = lookup(dict, `${key}_${category}`) ?? lookup(dict, `${key}_other`);
  }
  template ??= lookup(dict, key) ?? lookup(en, key) ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/** Reactive translation: components that call it re-render when the language changes. */
export function t(key: TKey, params?: TParams): string {
  return translate(lang.value, key, params);
}

/** Locale used for every Intl date: Swiss conventions in both languages (design uses CH formats). */
export function localeOf(language: ResolvedLanguage): string {
  return language === 'fr' ? 'fr-CH' : 'en-CH';
}
