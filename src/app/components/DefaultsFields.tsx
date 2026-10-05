/**
 * The currency, language and budget rows of Setup step 2 and of Settings › Defaults (spec §3.2,
 * §3.8): the same controls; each screen decides when its values are kept.
 */
import type { Language } from '@shared/api';
import { CURRENCIES } from '@shared/constants';
import { lang, t } from '../i18n';
import { Select } from './Controls';

interface Props {
  /** Id of the budget input, for its label. */
  budgetId: string;
  currency: string;
  onCurrency: (code: string) => void;
  language: Language;
  onLanguage: (language: Language) => void;
  /** The budget as typed. */
  budget: string;
  onBudget: (text: string) => void;
  onBudgetBlur: () => void;
  /** Enter leaves the budget field, where leaving it saves (Settings). */
  blurOnEnter?: boolean;
}

export default function DefaultsFields({ budgetId, currency, onCurrency, language, onLanguage, budget, onBudget, onBudgetBlur, blurOnEnter }: Props) {
  const ui = lang.value;
  return (
    <div class="kv">
      <div>{t('setup.currency')}</div>
      <div>
        <Select label={t('setup.currency')} value={currency} options={CURRENCIES.map((c) => ({ value: c.code, label: `${c.code} — ${c[ui]}` }))} onChange={onCurrency} />
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
          onChange={(v) => onLanguage(v as Language)}
        />
      </div>
      <label for={budgetId}>{t('setup.budget')}</label>
      <div class="row budget">
        <input
          id={budgetId}
          class="mono"
          inputMode="decimal"
          autocomplete="off"
          placeholder={t('setup.noBudget')}
          value={budget}
          // Sized to the text so "/ month" follows it, as in the design (mono digits are 1ch).
          style={{ width: `calc(${Math.max(5, budget.length)}ch + 2px)` }}
          onInput={(e) => onBudget(e.currentTarget.value)}
          onBlur={onBudgetBlur}
          onKeyDown={
            blurOnEnter
              ? (e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }
              : undefined
          }
        />
        <span class="mono per">{t('setup.perMonth')}</span>
      </div>
    </div>
  );
}
