/**
 * Analytics drill-down: one category over the selected period (total, share, entries) and its last
 * six months. Tapping an entry hands it to the caller to edit.
 */
import { useEffect, useState } from 'preact/hooks';
import type { Entry, MonthsSummary, SummaryCategory } from '@shared/api';
import type { DayRange } from '@shared/dates';
import { formatAmount, percentOf } from '@shared/money';
import { t } from '../i18n';
import { api, isAbortError } from '../lib/api';
import { monthPoints, trendWindow } from '../lib/analytics';
import { todayLocal } from '../lib/format';
import { currency } from '../lib/store';
import EntryList from './EntryList';
import { IconClose } from './Icons';
import MonthColumns from './MonthColumns';
import Sheet from './Sheet';

interface Props {
  category: SummaryCategory;
  range: DayRange;
  periodLabel: string;
  periodTotalCents: number;
  onOpenEntry: (entry: Entry) => void;
  onClose: () => void;
}

type Load<T> = { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error' };

const NO_ENTRIES: ReadonlySet<string> = new Set();

export default function CategorySheet({ category, range, periodLabel, periodTotalCents, onOpenEntry, onClose }: Props) {
  const today = todayLocal();
  const months = trendWindow(range, today);
  const [entries, setEntries] = useState<Load<Entry[]>>({ status: 'loading' });
  const [trend, setTrend] = useState<Load<MonthsSummary>>({ status: 'loading' });
  const name = category.name ?? t('common.other');

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

  return (
    <Sheet label={name} onClose={onClose} class="cat-sheet">
      <div class="sheet-head">
        <span class="lbl ink">{name}</span>
        <button type="button" class="ibtn ghost sm" aria-label={t('common.close')} onClick={onClose}>
          <IconClose />
        </button>
      </div>
      <div class="amount-row">
        <span class="big ov-num">{formatAmount(category.total_cents)}</span>
        <span class="cur">{currency.value}</span>
      </div>
      <div class="meta-row stats">
        <span>
          {t('category.ofPeriod', { share, period: periodLabel })} · {t('category.entries', { count: category.count })}
        </span>
      </div>

      <h3 class="lbl sec">{t('category.trend')}</h3>
      {trend.status === 'ready' ? <MonthColumns points={monthPoints(trend.data.months, category.category_id)} highlight={months.to} /> : null}
      {trend.status === 'loading' ? <div class="cols-ph" /> : null}

      {entries.status === 'error' ? <p class="ov-note">{t('category.loadFailed')}</p> : null}
      {entries.status === 'ready' ? <EntryList entries={entries.data} today={today} currency={currency.value} fresh={NO_ENTRIES} onOpen={onOpenEntry} /> : null}
    </Sheet>
  );
}
