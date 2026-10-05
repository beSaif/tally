/** Sign up / Log in (spec §3.1): same visual language as setup. */
import { useState } from 'preact/hooks';
import { lang, t, type TKey } from '../i18n';
import { api, isApiError } from '../lib/api';
import { bootstrap } from '../lib/store';
import { linkTo } from '../router';
import { Lines } from '../components/Controls';
import Wordmark from '../components/Wordmark';

const ERRORS: Partial<Record<string, TKey>> = {
  invalid_credentials: 'auth.err.invalid_credentials',
  email_taken: 'auth.err.email_taken',
  invite_required: 'auth.err.invite_required',
  signups_disabled: 'auth.err.signups_disabled',
  rate_limited: 'auth.err.rate_limited',
  validation: 'auth.err.validation',
  offline: 'auth.err.offline',
};

export default function AuthScreen({ mode }: { mode: 'login' | 'signup' }) {
  const signup = mode === 'signup';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [invite, setInvite] = useState('');
  const [needInvite, setNeedInvite] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TKey | null>(null);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    const cleanEmail = email.trim();
    if (!/^\S+@\S+\.\S+$/.test(cleanEmail) || (signup && password.length < 8) || !password) {
      setError(signup ? 'auth.err.validation' : 'auth.err.invalid_credentials');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (signup) {
        await api.signup({ email: cleanEmail, password, language: lang.value, ...(needInvite && invite.trim() ? { invite_code: invite.trim() } : {}) });
      } else {
        await api.login({ email: cleanEmail, password });
      }
      // The gate takes it from here: /setup when this device has no key or setup is unfinished, else home.
      await bootstrap();
    } catch (err) {
      const code = isApiError(err) ? err.code : 'internal';
      if (code === 'invite_required') setNeedInvite(true);
      setError(ERRORS[code] ?? 'auth.err.generic');
      setBusy(false);
    }
  };

  return (
    <main class="screen auth">
      <div class="auth-top">
        <Wordmark />
      </div>
      <h1 class="h1 headline">
        <Lines text={signup ? t('auth.signupTitle') : t('auth.loginTitle')} />
      </h1>
      <p class="lead">{t('auth.lead')}</p>
      <form class="auth-form" onSubmit={submit} noValidate>
        <label class="lbl first" for="auth-email">
          {t('auth.email')}
        </label>
        <div class="field">
          <div class="v">
            <input
              id="auth-email"
              type="email"
              name="email"
              autocomplete={signup ? 'email' : 'username'}
              autocapitalize="off"
              spellcheck={false}
              inputMode="email"
              value={email}
              onInput={(e) => setEmail(e.currentTarget.value)}
              required
            />
          </div>
        </div>
        <label class="lbl" for="auth-password">
          {t('auth.password')}
        </label>
        <div class="field">
          <div class="v">
            <input
              id="auth-password"
              type={reveal ? 'text' : 'password'}
              name="password"
              autocomplete={signup ? 'new-password' : 'current-password'}
              minLength={signup ? 8 : undefined}
              aria-describedby={signup ? 'auth-pw-hint' : undefined}
              value={password}
              onInput={(e) => setPassword(e.currentTarget.value)}
              required
            />
            <button type="button" class="pill" aria-pressed={reveal} onClick={() => setReveal(!reveal)}>
              {reveal ? t('auth.hide') : t('auth.show')}
            </button>
          </div>
        </div>
        {signup ? (
          <p class="hint" id="auth-pw-hint">
            {t('auth.passwordHint')}
          </p>
        ) : null}
        {signup && needInvite ? (
          <>
            <label class="lbl" for="auth-invite">
              {t('auth.inviteCode')}
            </label>
            <div class="field">
              <div class="v">
                <input id="auth-invite" type="text" name="invite" autocomplete="off" autocapitalize="off" value={invite} onInput={(e) => setInvite(e.currentTarget.value)} />
              </div>
            </div>
          </>
        ) : null}
        {error ? (
          <p class="err auth-err" role="alert">
            {t(error)}
          </p>
        ) : null}
        <div class="bottom">
          <button type="submit" class="btn primary" disabled={busy} aria-busy={busy}>
            {busy ? '…' : signup ? t('auth.createAccount') : t('auth.logIn')}
          </button>
          <a class="link switch" href={signup ? '/login' : '/signup'} onClick={linkTo(signup ? '/login' : '/signup')}>
            {signup ? t('auth.haveAccount') : t('auth.newHere')}
          </a>
        </div>
      </form>
    </main>
  );
}
