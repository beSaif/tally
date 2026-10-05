export const APP_NAME = 'Tally';
export const DEFAULT_MODEL = 'gemini-2.5-flash';
export const DEFAULT_CURRENCY = 'CHF';
export const SESSION_COOKIE = 'tally_session';
export const SESSION_DAYS = 30;
export const SESSION_RENEW_BELOW_DAYS = 15;
/** Keeps state, nonce and PKCE verifier between leaving for Google and coming back. */
export const OAUTH_COOKIE = 'tally_oauth';
export const OAUTH_COOKIE_SECONDS = 10 * 60;
export const GEMINI_KEY_STORAGE = 'tally.gemini.key';

export const DEFAULT_CATEGORIES: Record<'en' | 'fr', readonly string[]> = {
  en: ['Groceries', 'Dining', 'Transport', 'Home', 'Health', 'Fun', 'Shopping', 'Bills'],
  fr: ['Courses', 'Restaurants', 'Transport', 'Maison', 'Santé', 'Loisirs', 'Shopping', 'Factures'],
};

/** Currencies offered in the selector. Label is "CODE — Name" in the UI. */
export const CURRENCIES: ReadonlyArray<{ code: string; en: string; fr: string }> = [
  { code: 'CHF', en: 'Swiss franc', fr: 'Franc suisse' },
  { code: 'EUR', en: 'Euro', fr: 'Euro' },
  { code: 'USD', en: 'US dollar', fr: 'Dollar américain' },
  { code: 'GBP', en: 'Pound sterling', fr: 'Livre sterling' },
  { code: 'JPY', en: 'Japanese yen', fr: 'Yen japonais' },
  { code: 'CAD', en: 'Canadian dollar', fr: 'Dollar canadien' },
  { code: 'AUD', en: 'Australian dollar', fr: 'Dollar australien' },
  { code: 'INR', en: 'Indian rupee', fr: 'Roupie indienne' },
  { code: 'SEK', en: 'Swedish krona', fr: 'Couronne suédoise' },
  { code: 'NOK', en: 'Norwegian krone', fr: 'Couronne norvégienne' },
  { code: 'DKK', en: 'Danish krone', fr: 'Couronne danoise' },
  { code: 'PLN', en: 'Polish złoty', fr: 'Złoty polonais' },
  { code: 'CZK', en: 'Czech koruna', fr: 'Couronne tchèque' },
  { code: 'AED', en: 'UAE dirham', fr: 'Dirham des ÉAU' },
  { code: 'SGD', en: 'Singapore dollar', fr: 'Dollar de Singapour' },
  { code: 'BRL', en: 'Brazilian real', fr: 'Réal brésilien' },
  { code: 'MXN', en: 'Mexican peso', fr: 'Peso mexicain' },
  { code: 'ZAR', en: 'South African rand', fr: 'Rand sud-africain' },
  { code: 'TRY', en: 'Turkish lira', fr: 'Livre turque' },
  { code: 'CNY', en: 'Chinese yuan', fr: 'Yuan chinois' },
  { code: 'KRW', en: 'South Korean won', fr: 'Won sud-coréen' },
];

export const BUDGET_THRESHOLDS = [50, 80, 100] as const;
export const CRON_SLOT_MINUTES = 15;
export const WEEKLY_HOUR = '09:00';
export const MONTHLY_HOUR = '09:00';
