/**
 * App-wide state (signals): session, user, settings, categories and this device's Gemini key.
 * The key lives only in localStorage (spec §7.6); it is tagged with the account that saved it so a
 * second account on a shared device is not silently handed someone else's key.
 */
import { computed, effect, signal } from '@preact/signals';
import type { Bootstrap, CategoriesInput, Category, Language, Settings, SettingsInput, User } from '@shared/api';
import { DEFAULT_CURRENCY, DEFAULT_MODEL, GEMINI_KEY_STORAGE } from '@shared/constants';
import { api, isApiError } from './api';
import { lang, languagePref } from '../i18n';

export type SessionState = 'loading' | 'anon' | 'authed';

export const sessionState = signal<SessionState>('loading');
export const user = signal<User | null>(null);
export const settings = signal<Settings | null>(null);
export const categories = signal<Category[]>([]);
export const geminiKey = signal<string | null>(null);
/** Language shown while it is being chosen in setup, before it is saved. */
export const languagePreview = signal<Language | null>(null);

export const model = computed(() => settings.value?.model?.trim() || DEFAULT_MODEL);
export const currency = computed(() => settings.value?.currency ?? DEFAULT_CURRENCY);
export const categoryNames = computed(() => categories.value.map((c) => c.name));

effect(() => {
  languagePref.value = languagePreview.value ?? settings.value?.language ?? 'auto';
});
effect(() => {
  document.documentElement.lang = lang.value;
});

const OWNER_KEY = 'tally.gemini.owner';
const BOOT_CACHE = 'tally.boot';

/** localStorage can throw (private mode, blocked storage); every access goes through here. */
function store(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    store()?.setItem(key, value);
  } catch {
    /* quota or blocked storage: the app still works for this session */
  }
}

function safeRemove(key: string): void {
  try {
    store()?.removeItem(key);
  } catch {
    /* ignore */
  }
}

function keyFor(userId: string): string | null {
  const s = store();
  const key = s?.getItem(GEMINI_KEY_STORAGE) ?? null;
  if (!key) return null;
  const owner = s?.getItem(OWNER_KEY) ?? null;
  if (owner && owner !== userId) return null;
  if (!owner) safeSet(OWNER_KEY, userId);
  return key;
}

export function saveGeminiKey(key: string): void {
  const trimmed = key.trim();
  safeSet(GEMINI_KEY_STORAGE, trimmed);
  if (user.value) safeSet(OWNER_KEY, user.value.id);
  geminiKey.value = trimmed;
}

export function forgetGeminiKey(): void {
  safeRemove(GEMINI_KEY_STORAGE);
  safeRemove(OWNER_KEY);
  geminiKey.value = null;
}

const byPosition = (list: Category[]) => [...list].sort((a, b) => a.position - b.position);

function writeBootCache(): void {
  if (!user.value || !settings.value) return;
  const b: Bootstrap = { user: user.value, settings: settings.value, categories: categories.value };
  safeSet(BOOT_CACHE, JSON.stringify(b));
}

function readBootCache(): Bootstrap | null {
  try {
    const raw = store()?.getItem(BOOT_CACHE);
    if (!raw) return null;
    const b = JSON.parse(raw) as Bootstrap;
    return b && b.user && b.settings ? b : null;
  } catch {
    return null;
  }
}

export function applyBootstrap(b: Bootstrap): void {
  user.value = b.user;
  settings.value = b.settings;
  categories.value = byPosition(b.categories);
  geminiKey.value = keyFor(b.user.id);
  sessionState.value = 'authed';
  writeBootCache();
}

export function signedOut(): void {
  user.value = null;
  settings.value = null;
  categories.value = [];
  geminiKey.value = null;
  languagePreview.value = null;
  safeRemove(BOOT_CACHE);
  sessionState.value = 'anon';
}

/** First load. Offline with a cached session: start from the cache (the shell works offline). */
export async function bootstrap(): Promise<void> {
  try {
    applyBootstrap(await api.me({ quiet401: true }));
  } catch (err) {
    const cached = isApiError(err) && err.code !== 'unauthorized' ? readBootCache() : null;
    if (cached) applyBootstrap(cached);
    else signedOut();
  }
}

/** Silent refresh (tab visible again, another device changed settings). */
export async function refreshBootstrap(): Promise<void> {
  if (sessionState.value !== 'authed') return;
  try {
    applyBootstrap(await api.me());
  } catch {
    /* 401 is handled by the API layer; anything else keeps the current state */
  }
}

export async function updateSettings(input: SettingsInput): Promise<Settings> {
  const res = await api.putSettings(input);
  settings.value = res.settings;
  writeBootCache();
  return res.settings;
}

export async function replaceCategories(list: CategoriesInput['categories']): Promise<Category[]> {
  const res = await api.putCategories({ categories: list });
  categories.value = byPosition(res.categories);
  writeBootCache();
  return categories.value;
}

/** Category id for a name (case-insensitive), or null for "Other"/unknown. */
export function categoryIdFor(name: string | null | undefined): string | null {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  return categories.value.find((c) => c.name.toLowerCase() === n)?.id ?? null;
}
