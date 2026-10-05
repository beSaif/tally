/** Settings (spec §3.8): Gemini, defaults, categories, notifications, account, install, about. */
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { Category, NotificationPrefs, PushSubscriptionRow } from '@shared/api';
import { toLocalDay } from '@shared/dates';
import { formatAmount, parseAmount } from '@shared/money';
import { version } from '../../../package.json';
import { lang, t, type TKey } from '../i18n';
import { api } from '../lib/api';
import { dayShortMonth } from '../lib/format';
import { installed, installPrompt, promptInstall } from '../lib/install';
import { currentSubscription, disablePush, enablePush, isIOS, permission, PushError, pushSupport, unsubscribeLocally } from '../lib/push';
import { categories, forgetGeminiKey, geminiKey, model, replaceCategories, saveGeminiKey, settings, signedOut, updateSettings, user } from '../lib/store';
import { showToast } from '../lib/toast';
import { describeUserAgent } from '../lib/ua';
import { back, linkTo, navigate } from '../router';
import AddChip from '../components/AddChip';
import { Section, Toggle } from '../components/Controls';
import DefaultsFields from '../components/DefaultsFields';
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
        <a class="link about-link" href="/privacy" onClick={linkTo('/privacy')}>
          {t('settings.privacy')}
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
          <span class="mono key-value">{key ? maskKey(key, 6) : t('settings.noKey')}</span>
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
            class="mono bare"
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
      <DefaultsFields
        budgetId="set-budget"
        currency={s.currency}
        onCurrency={(v) => void save({ currency: v })}
        language={s.language}
        onLanguage={(v) => void save({ language: v })}
        budget={budget}
        onBudget={setBudget}
        onBudgetBlur={saveBudget}
        blurOnEnter
      />
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
      else await disablePush();
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
      if (sub && row.endpoint === sub.endpoint) await disablePush();
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
  const [confirming, setConfirming] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TKey | null>(null);
  if (!u) return null;

  const toggleConfirm = () => {
    setConfirming(!confirming);
    setConfirmEmail('');
    setError(null);
  };

  const logout = async () => {
    setBusy(true);
    // This device should stop receiving this account's notifications once signed out.
    await atMost(disablePushQuietly(), 2500);
    await api.logout().catch(() => undefined);
    signedOut();
    navigate('/login', { replace: true });
  };

  const deleteAccount = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.deleteAccount({ email: confirmEmail.trim() });
    } catch {
      // Nothing changed, notifications on this device included.
      setBusy(false);
      setError('settings.saveFailed');
      return;
    }
    await atMost(unsubscribeLocally(), 2500);
    forgetGeminiKey();
    signedOut();
    navigate('/login', { replace: true });
  };

  return (
    <Section title={t('settings.account')} id="set-account">
      <div class="kv">
        <div>{t('settings.email')}</div>
        <div class="email">{u.email}</div>
        <div>{t('settings.signIn')}</div>
        <div>{t('settings.signInGoogle')}</div>
      </div>
      <div class="account-btns">
        <button type="button" class="btn" disabled={busy} onClick={() => void logout()}>
          {t('settings.logout')}
        </button>
        <button type="button" class="btn danger" aria-expanded={confirming} onClick={toggleConfirm}>
          {t('settings.deleteAccount')}
        </button>
      </div>
      {confirming ? (
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
          {error ? <p class="err line">{t(error)}</p> : null}
          <div class="btns">
            <button type="button" class="btn" onClick={toggleConfirm}>
              {t('common.cancel')}
            </button>
            <button type="submit" class="btn danger-fill" disabled={busy || confirmEmail.trim().toLowerCase() !== u.email.toLowerCase()}>
              {busy ? '…' : t('settings.deleteForever')}
            </button>
          </div>
        </form>
      ) : null}
    </Section>
  );
}

async function disablePushQuietly(): Promise<void> {
  if (!pushSupport().ok) return;
  // Best effort: signing out must not depend on the push service.
  await disablePush().catch(() => undefined);
}

/** Waits for `work`, but not longer than `ms`: leaving the account must not hang on the push service. */
function atMost(work: Promise<unknown>, ms: number): Promise<unknown> {
  return Promise.race([work, new Promise((resolve) => setTimeout(resolve, ms))]);
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
