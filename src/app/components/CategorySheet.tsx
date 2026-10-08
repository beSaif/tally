/**
 * Analytics drill-down: one category over the selected period (total, share, budget, entries),
 * its last six months against their average, and its settings: a monthly budget and whether it is
 * a fixed cost. Tapping an entry hands it to the caller to edit.
 */
import { useEffect, useState } from 'preact/hooks';
import type { Entry, MonthsSummary, SummaryCategory } from '@shared/api';
import type { DayRange, PeriodKind } from '@shared/dates';
import { formatAmount, formatBudget, parseAmount, percentOf } from '@shared/money';
import { t } from '../i18n';
import { api, isAbortError } from '../lib/api';
import { averageCents, monthPoints, trendWindow } from '../lib/analytics';
import { amountInputValue, todayLocal } from '../lib/format';
import { categories, currency, updateCategory } from '../lib/store';
import { Toggle } from './Controls';
import EntryList from './EntryList';
import { IconClose } from './Icons';
import MonthColumns, { wholeAmount } from './MonthColumns';
import Sheet from './Sheet';

interface Props {
  category: SummaryCategory;
  kind: PeriodKind;
  range: DayRange;
  periodLabel: string;
  periodTotalCents: number;
  onOpenEntry: (entry: Entry) => void;
  onClose: () => void;
}

type Load<T> = { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error' };

const NO_ENTRIES: ReadonlySet<string> = new Set();

export default function CategorySheet({ category, kind, range, periodLabel, periodTotalCents, onOpenEntry, onClose }: Props) {
  const today = todayLocal();
  const months = trendWindow(range, today);
  const [entries, setEntries] = useState<Load<Entry[]>>({ status: 'loading' });
  const [trend, setTrend] = useState<Load<MonthsSummary>>({ status: 'loading' });
  const name = category.name ?? t('common.other');
  const own = categories.value.find((c) => c.id === category.category_id) ?? null;
  const budget = own?.budget_cents ?? null;

  useEffect(() => {
    const ctrl = new AbortController();
    const fail = (set: (l: { status: 'error' }) => void) => (err: unknown) => {
      if (!isAbortError(err)) set({ status: 'error' });
    };
    api
      .listEntries(range.from, range.to, { signal: ctrl.signal })
      .then(({ entries: all }) => setEntries({ status: 'ready', data: all.filter((e) => e.category_id === category.category_id) }))
      .catch(fail(setEntries));
    api
      .summaryMonths(months.from, months.to, { signal: ctrl.signal })
      .then((data) => setTrend({ status: 'ready', data }))
      .catch(fail(setTrend));
    return () => ctrl.abort();
  }, [category.category_id, range.from, range.to]);

  const share = percentOf(category.total_cents, periodTotalCents);
  const average = trend.status === 'ready' ? averageCents(trend.data.months, months.to, category.category_id) : null;
  const used = kind === 'month' && budget ? percentOf(category.total_cents, budget) : null;

  return (
    <Sheet label={name} onClose={onClose} class="cat-sheet">
      <div class="sheet-head">
        <span class="lbl ink">{name}</span>
        <button type="button" class="ibtn ghost sm" aria-label={t('common.close')} onClick={onClose}>
          <IconClose />
        </button>
      </div>
      <div class="amount-row">
        <span class={`big ov-num${used !== null && used >= 100 ? ' over' : ''}`}>{formatAmount(category.total_cents)}</span>
        <span class="cur">{currency.value}</span>
      </div>
      <div class="meta-row stats">
        <span>
          {t('category.ofPeriod', { share, period: periodLabel })} · {t('category.entries', { count: category.count })}
        </span>
      </div>
      {used !== null && budget ? (
        <div class="cat-budget">
          <div class="meta-row">
            <span>{t('report.ofBudget', { pct: used, budget: formatBudget(budget) })}</span>
            <span>
              {category.total_cents <= budget
                ? t('category.left', { amount: formatAmount(budget - category.total_cents) })
                : t('category.over', { amount: formatAmount(category.total_cents - budget) })}
            </span>
          </div>
          <div class="track" aria-hidden="true">
            <div class={`fill${used >= 100 ? ' acc' : ''}`} style={{ width: `${Math.min(100, used)}%` }} />
          </div>
        </div>
      ) : null}

      <h3 class="lbl sec">
        {t('category.trend')}
        {average !== null ? <span class="sec-aside"> · {t('category.avg', { amount: wholeAmount(average) })}</span> : null}
      </h3>
      {trend.status === 'ready' ? <MonthColumns points={monthPoints(trend.data.months, category.category_id)} highlight={months.to} averageCents={average} /> : null}
      {trend.status === 'loading' ? <div class="cols-ph" /> : null}

      {own ? <CategorySettings key={own.id} id={own.id} budget={budget} fixed={own.fixed === true} /> : <p class="note cat-hint">{t('category.otherHint')}</p>}

      {entries.status === 'error' ? <p class="ov-note">{t('category.loadFailed')}</p> : null}
      {entries.status === 'ready' ? (
        <EntryList entries={entries.data} today={today} currency={currency.value} fresh={NO_ENTRIES} onOpen={onOpenEntry} showCategory={false} />
      ) : null}
    </Sheet>
  );
}

/** Monthly budget (set, change, remove) and the fixed-cost switch, saved as they change. */
function CategorySettings({ id, budget, fixed }: { id: string; budget: number | null; fixed: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const cents = parseAmount(draft);
  const valid = cents !== null && cents >= 100;

  const save = async (patch: { budget_cents?: number | null; fixed?: boolean }) => {
    setBusy(true);
    setError(false);
    try {
      await updateCategory(id, patch);
      setEditing(false);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div class="kv cat-settings">
        <div>{t('category.budget')}</div>
        {editing ? (
          <form
            class="row budget-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (valid) void save({ budget_cents: cents });
            }}
          >
            <input
              type="text"
              inputMode="decimal"
              class="mono"
              value={draft}
              placeholder={t('category.budgetPlaceholder')}
              aria-label={t('category.budget')}
              autoFocus
              onInput={(e) => setDraft(e.currentTarget.value)}
            />
            <span class="pills">
              <button type="submit" class="pill on" disabled={!valid || busy}>
                {t('common.save')}
              </button>
              {budget ? (
                <button type="button" class="pill" disabled={busy} onClick={() => void save({ budget_cents: null })}>
                  {t('common.remove')}
                </button>
              ) : (
                <button type="button" class="pill" onClick={() => setEditing(false)}>
                  {t('common.cancel')}
                </button>
              )}
            </span>
          </form>
        ) : (
          <div class="row">
            <span class="mono">{budget ? wholeAmount(budget) : t('category.noBudget')}</span>
            <button
              type="button"
              class="pill"
              onClick={() => {
                setDraft(budget ? amountInputValue(budget).replace(/\.00$/, '') : '');
                setEditing(true);
              }}
            >
              {budget ? t('common.change') : t('category.setBudget')}
            </button>
          </div>
        )}
        <div>
          {t('category.fixed')}
          <span class="note">{t('category.fixedHint')}</span>
        </div>
        <div class="row">
          <Toggle checked={fixed} disabled={busy} label={t('category.fixed')} onChange={(v) => void save({ fixed: v })} />
        </div>
      </div>
      {error ? <p class="err line">{t('entry.saveFailed')}</p> : null}
    </>
  );
}
