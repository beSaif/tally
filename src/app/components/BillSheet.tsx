/**
 * A bill's own form: keeping a habit Tally spotted (prefilled from it), or editing a bill. New bills
 * said out loud go through the capture sheet instead.
 */
import { useId, useState } from 'preact/hooks';
import type { Bill, BillMode, BillSuggestion, Cadence } from '@shared/api';
import { isValidDay } from '@shared/dates';
import { formatAmount, parseAmount } from '@shared/money';
import { lang, t, type TKey } from '../i18n';
import { createBill, dismissSuggestion, updateBill } from '../lib/bills';
import { amountInputValue, dayShortMonth } from '../lib/format';
import { categories } from '../lib/store';
import { CadenceChips, ModeSwitch } from './BillBits';
import Sheet from './Sheet';

export type BillSheetFor = { kind: 'keep'; suggestion: BillSuggestion } | { kind: 'edit'; bill: Bill };

interface Form {
  amount: string;
  description: string;
  categoryId: string | null;
  cadence: Cadence;
  nextDue: string;
  mode: BillMode;
}

function formOf(target: BillSheetFor): Form {
  if (target.kind === 'edit') {
    const b = target.bill;
    return { amount: amountInputValue(b.amount_cents), description: b.description, categoryId: b.category_id, cadence: b.cadence, nextDue: b.next_due, mode: b.mode };
  }
  const s = target.suggestion;
  // The category it had, if it is still one of the person's.
  const categoryId = s.category_id && categories.value.some((c) => c.id === s.category_id) ? s.category_id : null;
  return { amount: amountInputValue(s.amount_cents), description: s.description, categoryId, cadence: s.cadence, nextDue: s.next_due, mode: 'ask' };
}

export default function BillSheet({ target, onClose, onSaved }: { target: BillSheetFor; onClose: () => void; onSaved?: (bill: Bill) => void }) {
  const id = useId();
  const [form, setForm] = useState<Form>(() => formOf(target));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TKey | null>(null);
  const set = (patch: Partial<Form>) => {
    setError(null);
    setForm((f) => ({ ...f, ...patch }));
  };
  const keep = target.kind === 'keep';
  const amountBad = parseAmount(form.amount) === null;

  const save = async () => {
    const cents = parseAmount(form.amount);
    if (cents === null) return setError('capture.invalidAmount');
    if (!form.description.trim()) return setError('capture.invalidWhat');
    if (!isValidDay(form.nextDue)) return setError('capture.invalidWhen');
    setBusy(true);
    try {
      const fields = { amount_cents: cents, description: form.description.trim(), category_id: form.categoryId, cadence: form.cadence, mode: form.mode };
      const bill =
        target.kind === 'keep'
          ? (await createBill({ ...fields, currency: target.suggestion.currency, first_due: form.nextDue })).bill
          : await updateBill(target.bill.id, { ...fields, next_due: form.nextDue });
      onSaved?.(bill);
      onClose();
    } catch {
      setBusy(false);
      setError('bills.failed');
    }
  };

  return (
    <Sheet label={keep ? t('bills.spotted') : t('bills.editTitle')} onClose={busy ? undefined : onClose} class="bill-sheet">
      <div class="sheet-head">
        <span class={`lbl state${keep ? ' ink' : ''}`}>
          {keep ? <span class="dot" /> : null}
          {keep ? t('bills.spotted') : t('bills.editTitle')}
        </span>
      </div>
      {target.kind === 'keep' ? (
        <ul class="seen">
          {target.suggestion.seen.map((d) => (
            <li key={d}>
              <span class="lbl">{dayShortMonth(d, lang.value)}</span>
              <span class="mono">{formatAmount(target.suggestion.amount_cents)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div class="kv edit">
        <label for={`${id}-a`}>{t('capture.amount')}</label>
        <div class="row amount-edit">
          <input
            id={`${id}-a`}
            class={`mono amount-input${amountBad ? ' bad' : ''}`}
            inputMode="decimal"
            autocomplete="off"
            value={form.amount}
            aria-invalid={amountBad}
            style={{ width: `calc(${Math.max(4, form.amount.length)}ch + 2px)` }}
            onInput={(e) => set({ amount: e.currentTarget.value })}
          />
          <span class="cur">{target.kind === 'keep' ? target.suggestion.currency : target.bill.currency}</span>
        </div>
        <label for={`${id}-w`}>{t('capture.what')}</label>
        <div>
          <input id={`${id}-w`} type="text" autocomplete="off" maxLength={200} value={form.description} onInput={(e) => set({ description: e.currentTarget.value })} />
        </div>
        <div id={`${id}-c`}>{t('capture.category')}</div>
        <div>
          <div class="chips" role="radiogroup" aria-labelledby={`${id}-c`}>
            {categories.value.map((c) => (
              <button key={c.id} type="button" role="radio" aria-checked={form.categoryId === c.id} class={`pill${form.categoryId === c.id ? ' on' : ''}`} onClick={() => set({ categoryId: c.id })}>
                {c.name}
              </button>
            ))}
            <button type="button" role="radio" aria-checked={form.categoryId === null} class={`pill${form.categoryId === null ? ' on' : ''}`} onClick={() => set({ categoryId: null })}>
              {t('common.other')}
            </button>
          </div>
        </div>
        <div id={`${id}-r`}>{t('bills.repeats')}</div>
        <div>
          <CadenceChips value={form.cadence} labelledBy={`${id}-r`} onChange={(c) => c && set({ cadence: c })} />
        </div>
        <label for={`${id}-d`}>{t('bills.nextDue')}</label>
        <div>
          <input id={`${id}-d`} class="mono" type="date" value={form.nextDue} onInput={(e) => set({ nextDue: e.currentTarget.value })} />
        </div>
      </div>
      <ModeSwitch value={form.mode} onChange={(mode) => set({ mode })} />
      {error ? (
        <p class="err line" role="alert">
          {t(error)}
        </p>
      ) : null}
      <div class="btns">
        {target.kind === 'keep' ? (
          <button
            type="button"
            class="btn"
            disabled={busy}
            onClick={() => {
              void dismissSuggestion(target.suggestion);
              onClose();
            }}
          >
            {t('bills.notABill')}
          </button>
        ) : (
          <button type="button" class="btn" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </button>
        )}
        <button type="button" class="btn primary" disabled={busy} onClick={() => void save()}>
          {busy ? '…' : keep ? t('bills.saveBill') : t('common.save')}
        </button>
      </div>
    </Sheet>
  );
}
