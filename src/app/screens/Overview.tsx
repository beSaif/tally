/**
 * Analytics (design A.3 + C.3, spec §3.6): week / month / year totals, category bars with a
 * drill-down per category, the month's report, export, ask.
 */
import { useEffect, useState } from 'preact/hooks';
import type { Entry, Summary, SummaryCategory } from '@shared/api';
import { periodRange, previousRange, shiftAnchor, type PeriodKind } from '@shared/dates';
import { formatAmount } from '@shared/money';
import { lang, t } from '../i18n';
import { api, isAbortError } from '../lib/api';
import { elapsedDays, elapsedMonths, monthLong, periodLabel, todayLocal } from '../lib/format';
import { currency } from '../lib/store';
import { linkTo, route, setQuery } from '../router';
import AppTopline from '../components/AppTopline';
import AskBox from '../components/AskBox';
import CategoryBars from '../components/CategoryBars';
import CategorySheet from '../components/CategorySheet';
import EntrySheet from '../components/EntrySheet';

const KINDS: readonly PeriodKind[] = ['week', 'month', 'year'];

function kindOf(p: string | null): PeriodKind {
  return p === 'week' || p === 'year' ? p : 'month';
}

type Load = { status: 'loading' } | { status: 'ready'; summary: Summary } | { status: 'error' };

export default function Overview() {
  const kind = kindOf(route.value.query.get('p'));
  const today = todayLocal();
  const [anchor, setAnchor] = useState(today);
  const range = periodRange(kind, anchor);
  const prev = previousRange(kind, range);
  const nextRange = periodRange(kind, shiftAnchor(kind, anchor, 1));
  const canGoNext = nextRange.from <= today;
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [category, setCategory] = useState<SummaryCategory | null>(null);
  const [entry, setEntry] = useState<Entry | null>(null);
  const language = lang.value;

  useEffect(() => {
    const ctrl = new AbortController();
    setLoad((l) => (l.status === 'ready' ? l : { status: 'loading' }));
    api
      .summary({ from: range.from, to: range.to, prev_from: prev.from, prev_to: prev.to }, { signal: ctrl.signal })
      .then((summary) => setLoad({ status: 'ready', summary }))
      .catch((err: unknown) => {
        if (!isAbortError(err)) setLoad({ status: 'error' });
      });
    return () => ctrl.abort();
  }, [kind, range.from, range.to, attempt]);

  const summary = load.status === 'ready' && load.summary.from === range.from && load.summary.to === range.to ? load.summary : null;
  const total = summary?.total_cents ?? 0;
  const count = summary?.count ?? 0;
  const label = periodLabel(kind, range, language);
  let stats: string;
  if (kind === 'year') {
    const m = elapsedMonths(range, today);
    stats = t('overview.statsYear', { avg: formatAmount(m > 0 ? Math.round(total / m) : 0) });
  } else {
    const d = elapsedDays(range, today);
    stats = t('overview.stats', { count, avg: formatAmount(d > 0 ? Math.round(total / d) : 0) });
  }

  const reportUrl = `/report?m=${range.from.slice(0, 7)}`;

  return (
    <main class="screen overview">
      <AppTopline view="analytics" />

      <div class="tabs" role="tablist" aria-label={t('overview.periods')}>
        {KINDS.map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={k === kind}
            class={k === kind ? 'on' : ''}
            onClick={() => {
              if (k !== kind) setQuery({ p: k });
            }}
          >
            {t(`overview.${k}`)}
          </button>
        ))}
      </div>

      <div class="period">
        <button type="button" aria-label={t('overview.prev')} onClick={() => setAnchor(shiftAnchor(kind, anchor, -1))}>
          ‹
        </button>
        <h1 class="lbl" aria-live="polite">
          {label}
        </h1>
        <button type="button" aria-label={t('overview.next')} disabled={!canGoNext} onClick={() => setAnchor(shiftAnchor(kind, anchor, 1))}>
          ›
        </button>
      </div>

      <div class={`ov-total${summary ? '' : ' pending'}`}>
        <div class="amount-row">
          <span class="big ov-num">{formatAmount(total)}</span>
          <span class="cur">{currency.value}</span>
        </div>
        <div class="meta-row stats">
          <span>{stats}</span>
        </div>
      </div>

      {load.status === 'error' ? (
        <p class="ov-note">
          {t('overview.loadFailed')}{' '}
          <button type="button" class="link" onClick={() => setAttempt(attempt + 1)}>
            {t('common.tryAgain')}
          </button>
        </p>
      ) : null}
      {summary && summary.by_category.length > 0 ? <CategoryBars rows={summary.by_category} totalCents={total} onOpen={setCategory} /> : null}
      {summary && summary.by_category.length === 0 ? <p class="ov-note">{t('overview.empty')}</p> : null}

      <div class="ov-links">
        {kind === 'month' ? (
          <a href={reportUrl} onClick={linkTo(reportUrl)}>
            {t('overview.report', { month: monthLong(range.from, language) })}
          </a>
        ) : null}
        <a href={api.exportUrl(range.from, range.to)} download>
          {t('overview.export')}
        </a>
      </div>

      <AskBox key={`${kind}:${range.from}`} periodLabel={label} range={range} summary={summary} />

      {category ? (
        <CategorySheet
          key={`${category.category_id ?? 'other'}:${range.from}`}
          category={category}
          range={range}
          periodLabel={label}
          periodTotalCents={total}
          onOpenEntry={(e) => {
            setCategory(null);
            setEntry(e);
          }}
          onClose={() => setCategory(null)}
        />
      ) : null}
      {entry ? (
        <EntrySheet
          key={entry.id}
          entry={entry}
          onClose={() => {
            setEntry(null);
            // The entry may have moved category, amount or month: recount the period.
            setAttempt((a) => a + 1);
          }}
        />
      ) : null}
    </main>
  );
}
