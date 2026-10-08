/**
 * Analytics (design A.3 + C.3, spec §3.6): week / month / year totals, category bars with a
 * drill-down per category, fixed vs day-to-day, the month's report, export, ask. The period lives in
 * the URL (`?p=month&d=2026-09-14`), so going back or switching views returns to it.
 */
import { useEffect, useState } from 'preact/hooks';
import type { Entry, Summary, SummaryCategory } from '@shared/api';
import { comparableRange, periodRange, previousRange, shiftAnchor, type PeriodKind } from '@shared/dates';
import { formatAmount } from '@shared/money';
import { lang, t } from '../i18n';
import { anchorDay, splitFixed } from '../lib/analytics';
import { api, isAbortError } from '../lib/api';
import { comparedLabel, elapsedDays, elapsedMonths, monthLong, periodLabel, todayLocal } from '../lib/format';
import { categories, currency } from '../lib/store';
import { linkTo, route, setQuery } from '../router';
import AppTopline, { rememberAnalytics } from '../components/AppTopline';
import AskBox from '../components/AskBox';
import CategoryBars from '../components/CategoryBars';
import CategorySheet from '../components/CategorySheet';
import EntrySheet from '../components/EntrySheet';

const KINDS: readonly PeriodKind[] = ['week', 'month', 'year'];

function kindOf(p: string | null): PeriodKind {
  return p === 'week' || p === 'year' ? p : 'month';
}

type Load = { status: 'loading' } | { status: 'ready'; summary: Summary } | { status: 'error' };

/** The drill-down that is open: a category id, or null for "Other". */
type Open = { id: string | null };

export default function Overview() {
  const query = route.value.query;
  const kind = kindOf(query.get('p'));
  const today = todayLocal();
  const anchor = anchorDay(query.get('d'), today);
  const setAnchor = (day: string) => setQuery({ d: day >= today ? null : day });
  const range = periodRange(kind, anchor);
  const prev = previousRange(kind, range);
  const compared = comparableRange(range, prev, today);
  const nextRange = periodRange(kind, shiftAnchor(kind, anchor, 1));
  const canGoNext = nextRange.from <= today;
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState<Open | null>(null);
  const [editing, setEditing] = useState<{ entry: Entry; from: Open } | null>(null);
  const language = lang.value;

  // The Ledger | Analytics switch comes back to this period.
  useEffect(() => rememberAnalytics(location.pathname + location.search), [route.value]);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoad((l) => (l.status === 'ready' ? l : { status: 'loading' }));
    api
      .summary({ from: range.from, to: range.to, prev_from: compared.from, prev_to: compared.to }, { signal: ctrl.signal })
      .then((summary) => setLoad({ status: 'ready', summary }))
      .catch((err: unknown) => {
        if (!isAbortError(err)) setLoad({ status: 'error' });
      });
    return () => ctrl.abort();
  }, [kind, range.from, range.to, compared.to, attempt]);

  const summary = load.status === 'ready' && load.summary.from === range.from && load.summary.to === range.to ? load.summary : null;
  const total = summary?.total_cents ?? 0;
  const count = summary?.count ?? 0;
  const label = periodLabel(kind, range, language);
  const comparedWith = comparedLabel(kind, prev, compared, language);
  let stats: string;
  if (kind === 'year') {
    const m = elapsedMonths(range, today);
    stats = t('overview.statsYear', { avg: formatAmount(m > 0 ? Math.round(total / m) : 0) });
  } else {
    const d = elapsedDays(range, today);
    stats = t('overview.stats', { count, avg: formatAmount(d > 0 ? Math.round(total / d) : 0) });
  }

  const reportUrl = `/report?m=${range.from.slice(0, 7)}`;
  const rows = summary?.by_category ?? [];
  const uncategorised = rows.find((r) => r.category_id === null)?.count ?? 0;
  const anyFixed = rows.some((r) => categories.value.some((c) => c.id === r.category_id && c.fixed === true));
  const split = anyFixed ? splitFixed(rows, categories.value) : null;
  const budgets = kind === 'month' ? new Map(categories.value.filter((c) => (c.budget_cents ?? 0) > 0).map((c) => [c.id, c.budget_cents ?? 0])) : undefined;
  // The open drill-down's row; a category emptied by an edit stays open at zero.
  const openRow: SummaryCategory | null = open
    ? (rows.find((r) => r.category_id === open.id) ?? {
        category_id: open.id,
        name: categories.value.find((c) => c.id === open.id)?.name ?? null,
        total_cents: 0,
        count: 0,
      })
    : null;

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
        {split ? (
          <div class="meta-row split">
            <span>{t('overview.split', { fixed: formatAmount(split.fixed), daily: formatAmount(split.daily) })}</span>
          </div>
        ) : null}
      </div>

      {load.status === 'error' ? (
        <p class="ov-note">
          {t('overview.loadFailed')}{' '}
          <button type="button" class="link" onClick={() => setAttempt(attempt + 1)}>
            {t('common.tryAgain')}
          </button>
        </p>
      ) : null}
      {summary && summary.by_category.length > 0 && (summary.previous?.total_cents ?? 0) > 0 ? <p class="lbl bars-cap">{t('overview.compared', { period: comparedWith })}</p> : null}
      {summary && summary.by_category.length > 0 ? (
        <CategoryBars rows={summary.by_category} totalCents={total} comparedWith={comparedWith} budgets={budgets} onOpen={(c) => setOpen({ id: c.category_id })} />
      ) : null}
      {uncategorised > 0 ? (
        <button type="button" class="link nudge" onClick={() => setOpen({ id: null })}>
          {t('overview.uncategorised', { count: uncategorised })}
        </button>
      ) : null}
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

      {open && openRow ? (
        <CategorySheet
          key={`${open.id ?? 'other'}:${range.from}:${attempt}`}
          category={openRow}
          kind={kind}
          range={range}
          periodLabel={label}
          periodTotalCents={total}
          onOpenEntry={(e) => {
            setEditing({ entry: e, from: open });
            setOpen(null);
          }}
          onClose={() => setOpen(null)}
        />
      ) : null}
      {editing ? (
        <EntrySheet
          key={editing.entry.id}
          entry={editing.entry}
          onClose={() => {
            // The entry may have moved category, amount or month: recount the period, then go
            // back to the category it was opened from.
            setAttempt((a) => a + 1);
            setOpen(editing.from);
            setEditing(null);
          }}
        />
      ) : null}
    </main>
  );
}
