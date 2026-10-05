/**
 * Setup (design 00.1 / 00.2, spec §3.2). Step 1 only when this device has no Gemini key, step 2
 * only when the account's setup is unfinished.
 */
import { useEffect, useState } from 'preact/hooks';
import type { Language } from '@shared/api';
import { CURRENCIES, DEFAULT_CATEGORIES } from '@shared/constants';
import { formatAmount, parseAmount } from '@shared/money';
import { lang, resolveLanguage, t, type TKey } from '../i18n';
import { defaultCurrency } from '../lib/region';
import { categories, geminiKey, languagePreview, model, replaceCategories, saveGeminiKey, settings, updateSettings } from '../lib/store';
import { navigate } from '../router';
import AddChip from '../components/AddChip';
import { Lines, Select } from '../components/Controls';
import KeyField, { KeyStatusLine, useKeyCheck } from '../components/KeyField';

const AI_STUDIO = 'https://aistudio.google.com/app/apikey';
const pad2 = (n: number) => String(n).padStart(2, '0');

function Steps({ current, total }: { current: number; total: number }) {
  return (
    <>
      <div class="step" aria-hidden="true">
        {Array.from({ length: total }, (_, i) => (
          <i key={i} class={i < current ? 'on' : ''} />
        ))}
      </div>
      <div class="lbl">{t('setup.step', { n: pad2(current), total: pad2(total) })}</div>
    </>
  );
}

export default function Setup() {
  // Decided once: finishing step 1 must not renumber the steps under the person's feet.
  const [needsKey] = useState(() => !geminiKey.value);
  const [needsDefaults] = useState(() => !settings.value?.setup_complete);
  const [step, setStep] = useState<1 | 2>(needsKey ? 1 : 2);
  const total = needsKey && needsDefaults ? 2 : 1;

  if (step === 1) {
    return (
      <KeyStep
        total={total}
        onDone={() => {
          if (needsDefaults) setStep(2);
          else navigate('/', { replace: true });
        }}
      />
    );
  }
  return <DefaultsStep current={total} total={total} />;
}

function KeyStep({ total, onDone }: { total: number; onDone: () => void }) {
  const { key, setKey, status } = useKeyCheck(model.value);
  return (
    <main class="screen setup">
      <Steps current={1} total={total} />
      <h1 class="h1 headline">
        <Lines text={t('setup.keyTitle')} />
      </h1>
      <p class="lead">{t('setup.keyLead')}</p>
      <div class="lbl field-lbl" id="key-label">
        {t('setup.keyLabel')}
      </div>
      <KeyField value={key} status={status} onChange={setKey} label={t('setup.keyLabel')} />
      <KeyStatusLine status={status} model={model.value} />
      <a class="link get-key" href={AI_STUDIO} target="_blank" rel="noopener noreferrer">
        {t('setup.getKey')}
      </a>
      <div class="bottom">
        <p class="note">{t('setup.keyNote')}</p>
        <button
          type="button"
          class="btn primary"
          disabled={status.kind !== 'ok'}
          onClick={() => {
            saveGeminiKey(key);
            onDone();
          }}
        >
          {t('setup.continue')}
        </button>
      </div>
    </main>
  );
}

interface Chip {
  id?: string;
  name: string;
  on: boolean;
}

function DefaultsStep({ current, total }: { current: number; total: number }) {
  const s = settings.value;
  const [currency, setCurrency] = useState(() => (s?.setup_complete ? s.currency : defaultCurrency(navigator.languages ?? [navigator.language])));
  const [language, setLanguage] = useState<Language>(s?.language ?? 'auto');
  const [budget, setBudget] = useState(() => (s?.budget_cents ? formatAmount(s.budget_cents) : ''));
  const [chips, setChips] = useState<Chip[]>(() => categories.value.map((c) => ({ id: c.id, name: c.name, on: true })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TKey | null>(null);

  useEffect(() => () => void (languagePreview.value = null), []);

  const chooseLanguage = (value: string) => {
    const next = value as Language;
    const before = resolveLanguage(language);
    const after = resolveLanguage(next);
    // Untouched default categories follow the language (renamed in place, so ids are kept).
    const defaults = DEFAULT_CATEGORIES[before];
    if (before !== after && chips.length === defaults.length && chips.every((c, i) => c.on && c.name === defaults[i])) {
      const target = DEFAULT_CATEGORIES[after];
      setChips(chips.map((c, i) => ({ ...c, name: target[i] ?? c.name })));
    }
    setLanguage(next);
    languagePreview.value = next;
  };

  const addChip = (name: string): boolean => {
    const existing = chips.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      setChips(chips.map((c) => (c === existing ? { ...c, on: true } : c)));
      return true;
    }
    setChips([...chips, { name, on: true }]);
    return true;
  };

  const start = async () => {
    const budgetCents = budget.trim() ? parseAmount(budget) : null;
    if (budget.trim() && (budgetCents === null || budgetCents > 1_000_000_000)) {
      setError('capture.invalidAmount');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await replaceCategories(chips.filter((c) => c.on).map((c) => (c.id ? { id: c.id, name: c.name } : { name: c.name })));
      // setup_complete last: the gate moves on to home as soon as it flips.
      await updateSettings({ currency, language, budget_cents: budgetCents, setup_complete: true });
      languagePreview.value = null;
      navigate('/', { replace: true });
    } catch {
      setBusy(false);
      setError('setup.saveFailed');
    }
  };

  const language2 = lang.value;
  return (
    <main class="screen setup">
      <Steps current={current} total={total} />
      <h1 class="h1 headline defaults">
        <Lines text={t('setup.defaultsTitle')} />
      </h1>
      <div class="kv">
        <div>{t('setup.currency')}</div>
        <div>
          <Select
            label={t('setup.currency')}
            value={currency}
            options={CURRENCIES.map((c) => ({ value: c.code, label: `${c.code} — ${c[language2]}` }))}
            onChange={setCurrency}
          />
        </div>
        <div>{t('setup.language')}</div>
        <div>
          <Select
            label={t('setup.language')}
            value={language}
            options={[
              { value: 'auto', label: t('lang.auto') },
              { value: 'en', label: t('lang.en') },
              { value: 'fr', label: t('lang.fr') },
            ]}
            onChange={chooseLanguage}
          />
        </div>
        <label for="setup-budget">{t('setup.budget')}</label>
        <div class="row budget">
          <input
            id="setup-budget"
            class="mono"
            inputMode="decimal"
            autocomplete="off"
            placeholder={t('setup.noBudget')}
            value={budget}
            // Sized to the text so "/ month" follows it, as in the design (mono digits are 1ch).
            style={{ width: `${Math.max(6, budget.length + 1)}ch` }}
            onInput={(e) => setBudget(e.currentTarget.value)}
            onBlur={() => {
              const cents = parseAmount(budget);
              if (budget.trim() && cents !== null) setBudget(formatAmount(cents));
            }}
          />
          <span class="mono per">{t('setup.perMonth')}</span>
        </div>
      </div>
      <div class="lbl cats-lbl">{t('setup.categoriesHint')}</div>
      <div class="chips cats">
        {chips.map((c, i) => (
          <button key={`${c.id ?? 'new'}-${i}`} type="button" class={`pill${c.on ? ' on' : ''}`} aria-pressed={c.on} onClick={() => setChips(chips.map((x) => (x === c ? { ...x, on: !x.on } : x)))}>
            {c.name}
          </button>
        ))}
        <AddChip onAdd={addChip} />
      </div>
      {error ? (
        <p class="err line" role="alert">
          {t(error)}
        </p>
      ) : null}
      <div class="bottom">
        <button type="button" class="btn primary" disabled={busy} onClick={() => void start()}>
          {busy ? '…' : t('setup.start')}
        </button>
      </div>
    </main>
  );
}
