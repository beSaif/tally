/** Sign in (spec §3.1): one screen, one button; Google does the identifying. */
import { useEffect, useState } from 'preact/hooks';
import type { SignInError } from '@shared/api';
import { lang, t, type TKey } from '../i18n';
import { api } from '../lib/api';
import { linkTo, route } from '../router';
import { Lines } from '../components/Controls';
import Wordmark from '../components/Wordmark';

const ERRORS: Record<SignInError | 'offline', TKey> = {
  cancelled: 'auth.err.cancelled',
  failed: 'auth.err.failed',
  signups_disabled: 'auth.err.signups_disabled',
  offline: 'auth.err.offline',
};
type ErrorKind = keyof typeof ERRORS;
const isErrorKind = (s: string | null): s is ErrorKind => s !== null && Object.hasOwn(ERRORS, s);

export default function AuthScreen() {
  // The Worker lands here with `?error=` when a sign-in did not go through.
  const fromServer = route.value.query.get('error');
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false);
  const error: ErrorKind | null = offline ? 'offline' : isErrorKind(fromServer) ? fromServer : null;

  // Coming back with the back button can restore the page from cache, busy state included.
  useEffect(() => {
    const reset = () => setBusy(false);
    window.addEventListener('pageshow', reset);
    return () => window.removeEventListener('pageshow', reset);
  }, []);

  const go = (e: MouseEvent) => {
    if (!navigator.onLine) {
      e.preventDefault();
      setOffline(true);
      return;
    }
    // The page is about to leave; while a slow server answers, the button says so.
    setBusy(true);
  };

  return (
    <main class="screen auth">
      <div class="auth-top">
        <Wordmark />
      </div>
      <h1 class="h1 headline">
        <Lines text={t('auth.title')} />
      </h1>
      <p class="lead">{t('auth.lead')}</p>
      {error ? (
        <p class="err auth-err" role="alert">
          {t(ERRORS[error])}
        </p>
      ) : null}
      <div class="bottom auth-bottom">
        <p class="note">{t('auth.note')}</p>
        <a class="btn primary" href={api.googleSignInUrl(lang.value)} aria-busy={busy} onClick={go}>
          {busy ? '…' : t('auth.google')}
        </a>
        <a class="link auth-switch" href="/privacy" onClick={linkTo('/privacy')}>
          {t('auth.privacy')}
        </a>
      </div>
    </main>
  );
}
