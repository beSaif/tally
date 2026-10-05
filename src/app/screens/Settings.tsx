/** Settings (spec §3.8): Gemini, defaults, categories, notifications, account, install, about. */
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { Category, Language, NotificationPrefs, PushSubscriptionRow } from '@shared/api';
import { CURRENCIES } from '@shared/constants';
import { toLocalDay } from '@shared/dates';
import { formatAmount, parseAmount } from '@shared/money';
import { version } from '../../../package.json';
import { lang, t, type TKey } from '../i18n';
import { api, isApiError } from '../lib/api';
import { dayShortMonth } from '../lib/format';
import { installed, installPrompt, promptInstall } from '../lib/install';
import { currentSubscription, disablePush, enablePush, isIOS, permission, PushError, pushSupport } from '../lib/push';
import { categories, forgetGeminiKey, geminiKey, model, replaceCategories, saveGeminiKey, settings, signedOut, updateSettings, user } from '../lib/store';
import { showToast } from '../lib/toast';
import { describeUserAgent } from '../lib/ua';
import { back, navigate } from '../router';
import AddChip from '../components/AddChip';
import { Section, Select, Toggle } from '../components/Controls';
import { IconTrash } from '../components/Icons';
import KeyField, { KeyStatusLine, maskKey, useKeyCheck } from '../components/KeyField';

const AI_STUDIO = 'https://aistudio.google.com/app/apikey';
const REPO = 'https://github.com/beSaif/tally';

function saveFailed(): void {
  showToast({ text: t('settings.saveFailed') });
}

export default function Settings() {
  const u = user.value;
  const s = settings.value;
  if (!u || !s) return null;
  return (
    <main class="screen settings">
      <header class="topline">
        <button type="button" onClick={() => back('/')}>
          {t('common.back')}
        </button>
        <h1 class="topline-title">{t('settings.title')}</h1>
      </header>
      <GeminiSection />
      <DefaultsSection />
      <CategoriesSection />
      <NotificationsSection />
      <AccountSection />
      <InstallSection />
      <Section title={t('settings.about')} id="set-about">
        <p class="about">{t('settings.version', { version })}</p>
        <a class="link" href={REPO} target="_blank" rel="noopener noreferrer">
          {t('settings.source')}
        </a>
      </Section>
    </main>
  );
}

// ------------------------------------------------------------------ Gemini

function GeminiSection() {
  const key = geminiKey.value;
  const [changing, setChanging] = useState(false);
  const [modelDraft, setModelDraft] = useState(model.value);
  const next = useKeyCheck(modelDraft.trim() || model.value);

  useEffect(() => setModelDraft(model.value), [model.value]);

  const saveModel = async () => {
    const value = modelDraft.trim();
    if (!value || value === model.value) {
      setModelDraft(model.value);
      return;
    }
    try {
      await updateSettings({ model: value.slice(0, 80) });
    } catch {
      setModelDraft(model.value);
      saveFailed();
    }
  };

  return (
    <Section title={t('settings.gemini')} id="set-gemini">
      <div class="kv">
        <div>{t('settings.apiKey')}</div>
        <div class="row">
          <span class="mono key-value">{key ? maskKey(key) : t('settings.noKey')}</span>
          <span class="pills">
            <button type="button" class="pill" aria-expanded={changing} onClick={() => setChanging(!changing)}>
              {t('common.change')}
            </button>
            {key ? (
              <button type="button" class="pill" onClick={forgetGeminiKey}>
                {t('common.remove')}
              </button>
            ) : null}
          </span>
        </div>
        <label for="set-model">{t('settings.model')}</label>
        <div>
          <input
            id="set-model"
            class="mono"
            type="text"
            autocomplete="off"
            autocapitalize="off"
            spellcheck={false}
            maxLength={80}
            value={modelDraft}
            onInput={(e) => setModelDraft(e.currentTarget.value)}
            onBlur={() => void saveModel()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
        </div>
      </div>
      {!changing && key ? <CurrentKeyStatus key={`${key}:${model.value}`} apiKey={key} /> : null}
      {changing ? (
        <div class="key-change">
          <KeyField value={next.key} status={next.status} onChange={next.setKey} label={t('setup.keyLabel')} autoFocus />
          <KeyStatusLine status={next.status} model={modelDraft.trim() || model.value} />
          <div class="btns">
            <button type="button" class="btn" onClick={() => setChanging(false)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              class="btn primary"
              disabled={next.status.kind !== 'ok'}
              onClick={() => {
                saveGeminiKey(next.key);
                setChanging(false);
                showToast({ text: t('settings.saved') });
              }}
            >
              {t('settings.saveKey')}
            </button>
          </div>
        </div>
      ) : null}
      <a class="link sub-link" href={AI_STUDIO} target="_blank" rel="noopener noreferrer">
        {t('setup.getKey')}
      </a>
      <p class="note">{t('settings.keyStored')}</p>
    </Section>
  );
}

/** Live check of the saved key against the saved model (re-mounted when either changes). */
function CurrentKeyStatus({ apiKey }: { apiKey: string }) {
  const { status } = useKeyCheck(model.value, apiKey);
  return <KeyStatusLine status={status} model={model.value} />;
}

// ------------------------------------------------------------------ defaults

function DefaultsSection() {
  const s = settings.value;
  const [budget, setBudget] = useState(s?.budget_cents ? formatAmount(s.budget_cents) : '');
  useEffect(() => setBudget(s?.budget_cents ? formatAmount(s.budget_cents) : ''), [s?.budget_cents]);
  if (!s) return null;
  const language = lang.value;

  const save = (input: Parameters<typeof updateSettings>[0]) => updateSettings(input).catch(saveFailed);

  const saveBudget = () => {
    const raw = budget.trim();
    const cents = raw ? parseAmount(raw) : null;
    if (raw && (cents === null || cents > 1_000_000_000)) {
      setBudget(s.budget_cents ? formatAmount(s.budget_cents) : '');
      return;
    }
    if (cents === s.budget_cents) {
      setBudget(cents ? formatAmount(cents) : '');
      return;
    }
    void save({ budget_cents: cents });
  };

  return (
    <Section title={t('settings.defaults')} id="set-defaults">
      <div class="kv">
        <div>{t('setup.currency')}</div>
        <div>
          <Select
            label={t('setup.currency')}
            value={s.currency}
            options={CURRENCIES.map((c) => ({ value: c.code, label: `${c.code} — ${c[language]}` }))}
            onChange={(v) => void save({ currency: v })}
          />
        </div>
        <div>{t('setup.language')}</div>
        <div>
          <Select
            label={t('setup.language')}
            value={s.language}
            options={[
              { value: 'auto', label: t('lang.auto') },
              { value: 'en', label: t('lang.en') },
              { value: 'fr', label: t('lang.fr') },
            ]}
            onChange={(v) => void save({ language: v as Language })}
          />
        </div>
        <label for="set-budget">{t('setup.budget')}</label>
        <div class="row budget">
          <input
            id="set-budget"
            class="mono"
            inputMode="decimal"
            autocomplete="off"
            placeholder={t('setup.noBudget')}
            value={budget}
            onInput={(e) => setBudget(e.currentTarget.value)}
            onBlur={saveBudget}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
          <span class="mono per">{t('setup.perMonth')}</span>
        </div>
      </div>
    </Section>
  );
}

// ------------------------------------------------------------------ categories

function CategoriesSection() {
  const list = categories.value;
  const [confirm, setConfirm] = useState<Category | null>(null);
  const [busy, setBusy] = useState(false);

  const replace = async (next: Array<{ id?: string; name: string }>): Promise<boolean> => {
    setBusy(true);
    try {
      await replaceCategories(next);
      return true;
    } catch {
      saveFailed();
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async (name: string): Promise<boolean> => {
    if (list.some((c) => c.name.toLowerCase() === name.toLowerCase())) return true;
    return replace([...list.map((c) => ({ id: c.id, name: c.name })), { name }]);
  };

  return (
    <Section title={t('settings.categories')} id="set-categories">
      <div class="chips cats">
        {list.map((c) => (
          <button key={c.id} type="button" class={`pill on${confirm?.id === c.id ? ' pending' : ''}`} disabled={busy} onClick={() => setConfirm(c)}>
            {c.name}
          </button>
        ))}
        <AddChip onAdd={add} disabled={busy} />
      </div>
      {confirm ? (
        <div class="confirm inline">
          <p class="confirm-q">{t('settings.removeCategory', { name: confirm.name })}</p>
          <div class="btns even">
            <button type="button" class="btn" onClick={() => setConfirm(null)}>
              {t('common.keep')}
            </button>
            <button
              type="button"
              class="btn danger"
              disabled={busy}
              onClick={async () => {
                const ok = await replace(list.filter((c) => c.id !== confirm.id).map((c) => ({ id: c.id, name: c.name })));
                if (ok) setConfirm(null);
              }}
            >
              {t('common.remove')}
            </button>
          </div>
        </div>
      ) : null}
    </Section>
  );
}

// ------------------------------------------------------------------ notifications

function NotificationsSection() {
  const support = useMemo(pushSupport, []);
  const [sub, setSub] = useState<PushSubscription | null>(null);
  const [rows, setRows] = useState<PushSubscriptionRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TKey | null>(null);
  const prefs = settings.value?.notifications;

  const refresh = async () => {
    const [current, list] = await Promise.all([
      currentSubscription(),
      api
        .pushSubscriptions()
        .then((r) => r.subscriptions)
        .catch(() => null),
    ]);
    setSub(current);
    if (list) setRows(list);
  };

  useEffect(() => {
    void refresh();
  }, []);

  if (!prefs) return null;
  const thisRow = sub ? rows.find((r) => r.endpoint === sub.endpoint) : undefined;
  const deviceOn = Boolean(sub && thisRow);
  const showPrefs = deviceOn || rows.length > 0;

  const setDevice = async (on: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (on) await enablePush(lang.value);
      else await disablePush(rows);
      await refresh();
    } catch (err) {
      setError(err instanceof PushError && err.code === 'denied' ? 'settings.notifDenied' : 'settings.notifFailed');
      await refresh().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  const savePref = (patch: Partial<NotificationPrefs>) => void updateSettings({ notifications: patch }).catch(saveFailed);

  const sendTest = async () => {
    setBusy(true);
    try {
      const { sent } = await api.pushTest(deviceOn && sub ? sub.endpoint : undefined);
      showToast({ text: sent > 0 ? t('settings.testSent', { count: sent }) : t('settings.testNone') });
    } catch {
      showToast({ text: t('toast.error') });
    } finally {
      setBusy(false);
    }
  };

  const removeDevice = async (row: PushSubscriptionRow) => {
    setBusy(true);
    try {
      if (sub && row.endpoint === sub.endpoint) await disablePush(rows);
      else await api.pushDelete(row.id);
      await refresh();
    } catch {
      saveFailed();
    } finally {
      setBusy(false);
    }
  };

  const blocked = support.ok && permission() === 'denied' && !deviceOn;

  return (
    <Section title={t('settings.notifications')} id="set-notifications">
      <ul class="rows">
        <li>
          <span class="row-text">
            <span class="n">{t('settings.notifDevice')}</span>
            {!support.ok && support.reason === 'unsupported' ? <span class="c">{t('settings.notifUnsupported')}</span> : null}
            {!support.ok && support.reason === 'ios-install' ? (
              <>
                <span class="c">{t('settings.notifIos')}</span>
                <span class="c howto">{t('settings.notifIosHow')}</span>
              </>
            ) : null}
            {blocked ? <span class="c">{t('settings.notifDenied')}</span> : null}
            {error && !blocked ? <span class="c err">{t(error)}</span> : null}
          </span>
          {support.ok ? <Toggle checked={deviceOn} disabled={busy} label={t('settings.notifDevice')} onChange={(v) => void setDevice(v)} /> : null}
        </li>
        {showPrefs ? (
          <>
            <li>
              <span class="row-text">
                <span class="n">{t('settings.reminder')}</span>
              </span>
              <Toggle checked={prefs.reminder} label={t('settings.reminder')} onChange={(v) => savePref({ reminder: v })} />
            </li>
            <li class={prefs.reminder ? '' : 'dimmed'}>
              <label class="row-text" for="set-reminder-time">
                <span class="n">{t('settings.reminderTime')}</span>
              </label>
              <input
                id="set-reminder-time"
                class="mono time"
                type="time"
                step={900}
                value={prefs.reminder_time}
                disabled={!prefs.reminder}
                onChange={(e) => {
                  const v = e.currentTarget.value;
                  if (/^\d{2}:\d{2}$/.test(v)) savePref({ reminder_time: v });
                }}
              />
            </li>
            <li class={prefs.reminder ? '' : 'dimmed'}>
              <span class="row-text">
                <span class="n">{t('settings.onlyIfEmpty')}</span>
              </span>
              <Toggle checked={prefs.reminder_only_if_empty} disabled={!prefs.reminder} label={t('settings.onlyIfEmpty')} onChange={(v) => savePref({ reminder_only_if_empty: v })} />
            </li>
            <li>
              <span class="row-text">
                <span class="n">{t('settings.budgetAlerts')}</span>
                <span class="c">{t('settings.budgetAlertsHint')}</span>
              </span>
              <Toggle checked={prefs.budget} label={t('settings.budgetAlerts')} onChange={(v) => savePref({ budget: v })} />
            </li>
            <li>
              <span class="row-text">
                <span class="n">{t('settings.weekly')}</span>
                <span class="c">{t('settings.weeklyHint')}</span>
              </span>
              <Toggle checked={prefs.weekly} label={t('settings.weekly')} onChange={(v) => savePref({ weekly: v })} />
            </li>
            <li>
              <span class="row-text">
                <span class="n">{t('settings.monthly')}</span>
                <span class="c">{t('settings.monthlyHint')}</span>
              </span>
              <Toggle checked={prefs.monthly} label={t('settings.monthly')} onChange={(v) => savePref({ monthly: v })} />
            </li>
          </>
        ) : null}
      </ul>
      {showPrefs ? (
        <>
          <button type="button" class="btn test-btn" disabled={busy} onClick={() => void sendTest()}>
            {t('settings.test')}
          </button>
          <div class="lbl devices-lbl">{t('settings.devices')}</div>
          <ul class="rows devices">
            {rows.map((r) => {
              const { browser, os } = describeUserAgent(r.user_agent);
              const name = browser && os ? t('settings.deviceOn', { browser, os }) : browser || os || t('settings.unknownDevice');
              const mine = Boolean(sub && r.endpoint === sub.endpoint);
              return (
                <li key={r.id}>
                  <span class="row-text">
                    <span class="n">
                      {name}
                      {mine ? <span class="pill on this-device">{t('settings.thisDevice')}</span> : null}
                    </span>
                    <span class="c">{t('settings.deviceSeen', { date: dayShortMonth(toLocalDay(new Date(r.last_seen_at)), lang.value) })}</span>
                  </span>
                  <button type="button" class="ibtn ghost sm" aria-label={t('settings.removeDevice', { name })} disabled={busy} onClick={() => void removeDevice(r)}>
                    <IconTrash />
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </Section>
  );
}

// ------------------------------------------------------------------ account

function AccountSection() {
  const u = user.value;
  const [mode, setMode] = useState<'idle' | 'password' | 'delete'>('idle');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmEmail, setConfirmEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TKey | null>(null);
  if (!u) return null;

  const reset = (m: typeof mode) => {
    setMode(m);
    setCurrent('');
    setNext('');
    setConfirmEmail('');
    setError(null);
  };

  const changePassword = async (e: Event) => {
    e.preventDefault();
    if (next.length < 8) return setError('auth.err.validation');
    setBusy(true);
    setError(null);
    try {
      await api.changePassword({ current, new: next });
      reset('idle');
      showToast({ text: t('settings.passwordChanged') });
    } catch (err) {
      setError(isApiError(err) && err.code === 'invalid_credentials' ? 'settings.wrongPassword' : 'settings.saveFailed');
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    setBusy(true);
    // This device should stop receiving this account's notifications once signed out.
    await Promise.race([disablePushQuietly(), new Promise((r) => setTimeout(r, 2500))]);
    await api.logout().catch(() => undefined);
    signedOut();
    navigate('/login', { replace: true });
  };

  const deleteAccount = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await disablePushQuietly();
      await api.deleteAccount({ password: current });
      forgetGeminiKey();
      signedOut();
      navigate('/signup', { replace: true });
    } catch (err) {
      setBusy(false);
      setError(isApiError(err) && err.code === 'invalid_credentials' ? 'settings.wrongPassword' : 'settings.saveFailed');
    }
  };

  return (
    <Section title={t('settings.account')} id="set-account">
      <div class="kv">
        <div>{t('settings.email')}</div>
        <div class="email">{u.email}</div>
        <div>{t('settings.password')}</div>
        <div class="row">
          <span class="mono">••••••••</span>
          <button type="button" class="pill" aria-expanded={mode === 'password'} onClick={() => reset(mode === 'password' ? 'idle' : 'password')}>
            {t('common.change')}
          </button>
        </div>
      </div>
      {mode === 'password' ? (
        <form class="inline-form" onSubmit={changePassword}>
          <label class="lbl" for="set-pw-current">
            {t('settings.currentPassword')}
          </label>
          <div class="field">
            <div class="v">
              <input id="set-pw-current" type="password" autocomplete="current-password" value={current} onInput={(e) => setCurrent(e.currentTarget.value)} />
            </div>
          </div>
          <label class="lbl" for="set-pw-new">
            {t('settings.newPassword')}
          </label>
          <div class="field">
            <div class="v">
              <input id="set-pw-new" type="password" autocomplete="new-password" minLength={8} value={next} onInput={(e) => setNext(e.currentTarget.value)} />
            </div>
          </div>
          {error ? <p class="err line">{t(error)}</p> : null}
          <div class="btns">
            <button type="button" class="btn" onClick={() => reset('idle')}>
              {t('common.cancel')}
            </button>
            <button type="submit" class="btn primary" disabled={busy || !current || !next}>
              {busy ? '…' : t('common.save')}
            </button>
          </div>
        </form>
      ) : null}
      <div class="account-btns">
        <button type="button" class="btn" disabled={busy} onClick={() => void logout()}>
          {t('settings.logout')}
        </button>
        <button type="button" class="btn danger" aria-expanded={mode === 'delete'} onClick={() => reset(mode === 'delete' ? 'idle' : 'delete')}>
          {t('settings.deleteAccount')}
        </button>
      </div>
      {mode === 'delete' ? (
        <form class="inline-form" onSubmit={deleteAccount}>
          <p class="warn">{t('settings.deleteWarning')}</p>
          <label class="lbl" for="set-del-email">
            {t('settings.email')}
          </label>
          <div class="field">
            <div class="v">
              <input id="set-del-email" type="email" autocomplete="off" autocapitalize="off" value={confirmEmail} onInput={(e) => setConfirmEmail(e.currentTarget.value)} />
            </div>
          </div>
          <label class="lbl" for="set-del-pw">
            {t('settings.password')}
          </label>
          <div class="field">
            <div class="v">
              <input id="set-del-pw" type="password" autocomplete="current-password" value={current} onInput={(e) => setCurrent(e.currentTarget.value)} />
            </div>
          </div>
          {error ? <p class="err line">{t(error)}</p> : null}
          <div class="btns">
            <button type="button" class="btn" onClick={() => reset('idle')}>
              {t('common.cancel')}
            </button>
            <button type="submit" class="btn danger-fill" disabled={busy || confirmEmail.trim().toLowerCase() !== u.email.toLowerCase() || !current}>
              {busy ? '…' : t('settings.deleteForever')}
            </button>
          </div>
        </form>
      ) : null}
    </Section>
  );
}

async function disablePushQuietly(): Promise<void> {
  try {
    if (!pushSupport().ok) return;
    const sub = await currentSubscription();
    if (!sub) return;
    const { subscriptions } = await api.pushSubscriptions();
    await disablePush(subscriptions);
  } catch {
    /* best effort: signing out must not depend on the push service */
  }
}

// ------------------------------------------------------------------ install

function InstallSection() {
  if (installed.value) return null;
  const prompt = installPrompt.value;
  return (
    <Section title={t('settings.install')} id="set-install">
      {prompt ? (
        <button type="button" class="btn install-btn" onClick={() => void promptInstall()}>
          {t('settings.installButton')}
        </button>
      ) : (
        <p class="howto">{isIOS() ? t('settings.installIos') : t('settings.installOther')}</p>
      )}
    </Section>
  );
}
