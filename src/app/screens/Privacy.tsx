/** Privacy policy: public, linked from the sign-in screen, Settings and Google's consent screen. */
import { t, type TKey } from '../i18n';
import { sessionState } from '../lib/store';
import { back } from '../router';

const REPO = 'https://github.com/beSaif/tally';

const SECTIONS: ReadonlyArray<readonly [TKey, TKey]> = [
  ['privacy.account', 'privacy.accountText'],
  ['privacy.entries', 'privacy.entriesText'],
  ['privacy.gemini', 'privacy.geminiText'],
  ['privacy.cookies', 'privacy.cookiesText'],
  ['privacy.push', 'privacy.pushText'],
  ['privacy.yours', 'privacy.yoursText'],
];

export default function Privacy() {
  return (
    <main class="screen privacy">
      <header class="topline">
        <button type="button" onClick={() => back(sessionState.value === 'authed' ? '/' : '/login')}>
          {t('common.back')}
        </button>
        <h1 class="topline-title">{t('privacy.title')}</h1>
      </header>
      <p class="lead">{t('privacy.lead')}</p>
      {SECTIONS.map(([title, text]) => (
        <section key={title}>
          <h2 class="lbl">{t(title)}</h2>
          <p class="text">{t(text)}</p>
        </section>
      ))}
      <a class="link" href={REPO} target="_blank" rel="noopener noreferrer">
        {t('settings.source')}
      </a>
      <div class="bottom" />
    </main>
  );
}
