/**
 * The entry fields of the confirm and edit sheets (design A.2 `.kv`): read-only, full edit mode,
 * and the compact edit row used inside the batch list (C.2).
 */
import { useId } from 'preact/hooks';
import { formatAmount, parseAmount } from '@shared/money';
import { lang, t } from '../i18n';
import { whenLabel } from '../lib/format';
import { categories } from '../lib/store';

export interface EntryDraft {
  amount: string;
  description: string;
  categoryId: string | null;
  occurredAt: string;
  note: string;
  currency: string;
}

export type DraftPatch = Partial<EntryDraft>;

function categoryName(id: string | null): string {
  return (id && categories.value.find((c) => c.id === id)?.name) || t('common.other');
}

export function EntryReadout({ draft, today }: { draft: EntryDraft; today: string }) {
  const cents = parseAmount(draft.amount) ?? 0;
  return (
    <div class="kv">
      <div>{t('capture.amount')}</div>
      <div class="amount">
        {formatAmount(cents)} <span class="cur">{draft.currency}</span>
      </div>
      <div>{t('capture.what')}</div>
      <div>{draft.description}</div>
      <div>{t('capture.category')}</div>
      <div>{categoryName(draft.categoryId)}</div>
      <div>{t('capture.when')}</div>
      <div class="mono when">{whenLabel(draft.occurredAt, today, lang.value)}</div>
      {draft.note ? (
        <>
          <div>{t('capture.note')}</div>
          <div class="mute">{draft.note}</div>
        </>
      ) : null}
    </div>
  );
}

export function EntryFields({ draft, onChange, autoFocus }: { draft: EntryDraft; onChange: (p: DraftPatch) => void; autoFocus?: boolean }) {
  const id = useId();
  const amountBad = parseAmount(draft.amount) === null;
  return (
    <div class="kv edit">
      <label for={`${id}-a`}>{t('capture.amount')}</label>
      <div class="row">
        <input
          id={`${id}-a`}
          class={`mono amount-input${amountBad ? ' bad' : ''}`}
          inputMode="decimal"
          autocomplete="off"
          value={draft.amount}
          autoFocus={autoFocus}
          aria-invalid={amountBad}
          onInput={(e) => onChange({ amount: e.currentTarget.value })}
        />
        <span class="cur">{draft.currency}</span>
      </div>
      <label for={`${id}-w`}>{t('capture.what')}</label>
      <div>
        <input id={`${id}-w`} type="text" autocomplete="off" maxLength={200} value={draft.description} onInput={(e) => onChange({ description: e.currentTarget.value })} />
      </div>
      <div id={`${id}-c`}>{t('capture.category')}</div>
      <div>
        <div class="chips" role="radiogroup" aria-labelledby={`${id}-c`}>
          {categories.value.map((c) => (
            <button key={c.id} type="button" role="radio" aria-checked={draft.categoryId === c.id} class={`pill${draft.categoryId === c.id ? ' on' : ''}`} onClick={() => onChange({ categoryId: c.id })}>
              {c.name}
            </button>
          ))}
          <button type="button" role="radio" aria-checked={draft.categoryId === null} class={`pill${draft.categoryId === null ? ' on' : ''}`} onClick={() => onChange({ categoryId: null })}>
            {t('common.other')}
          </button>
        </div>
      </div>
      <label for={`${id}-t`}>{t('capture.when')}</label>
      <div>
        <input id={`${id}-t`} class="mono" type="datetime-local" value={draft.occurredAt} onInput={(e) => onChange({ occurredAt: e.currentTarget.value.slice(0, 16) })} />
      </div>
      <label for={`${id}-n`}>{t('capture.note')}</label>
      <div>
        <input id={`${id}-n`} type="text" autocomplete="off" maxLength={500} placeholder={t('capture.optional')} value={draft.note} onInput={(e) => onChange({ note: e.currentTarget.value })} />
      </div>
    </div>
  );
}

/** One batch row in edit mode: amount + what, category + when, note. */
export function CompactFields({ draft, onChange }: { draft: EntryDraft; onChange: (p: DraftPatch) => void }) {
  const amountBad = parseAmount(draft.amount) === null;
  return (
    <div class="cfields">
      <div class="cf-row">
        <input
          class={`mono cf-amount${amountBad ? ' bad' : ''}`}
          inputMode="decimal"
          autocomplete="off"
          aria-label={t('capture.amount')}
          aria-invalid={amountBad}
          value={draft.amount}
          onInput={(e) => onChange({ amount: e.currentTarget.value })}
        />
        <input class="cf-what" type="text" autocomplete="off" maxLength={200} aria-label={t('capture.what')} value={draft.description} onInput={(e) => onChange({ description: e.currentTarget.value })} />
      </div>
      <div class="cf-row">
        <span class="sel cf-cat">
          <select aria-label={t('capture.category')} value={draft.categoryId ?? ''} onChange={(e) => onChange({ categoryId: e.currentTarget.value || null })}>
            {categories.value.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            <option value="">{t('common.other')}</option>
          </select>
          <span class="mono caret" aria-hidden="true">
            ▾
          </span>
        </span>
        <input class="mono cf-when" type="datetime-local" aria-label={t('capture.when')} value={draft.occurredAt} onInput={(e) => onChange({ occurredAt: e.currentTarget.value.slice(0, 16) })} />
      </div>
      <input class="cf-note" type="text" autocomplete="off" maxLength={500} aria-label={t('capture.note')} placeholder={`${t('capture.note')} · ${t('capture.optional')}`} value={draft.note} onInput={(e) => onChange({ note: e.currentTarget.value })} />
    </div>
  );
}
