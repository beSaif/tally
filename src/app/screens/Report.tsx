/**
 * Monthly report (`/report?m=YYYY-MM`): a month's total against the budget and the month before,
 * fixed vs day-to-day, a Gemini summary on request, its categories, biggest expenses and the six
 * months up to it against their average. The first-of-month notification opens last month's; "Save as PDF" prints it (print styles drop the app chrome).
 */
import { useEffect, useState } from 'preact/hooks';
import type { Entry, MonthsSummary, Summary } from '@shared/api';
import { addMonths, comparableRange, monthRange, previousRange } from '@shared/dates';
import { formatAmount, formatBudget, percentOf } from '@shared/money';
import { lang, t } from '../i18n';
import { api, isAbortError } from '../lib/api';
import { averageCents, biggestEntries, busiestDay, monthPoints, reportMonth, splitFixed, TREND_MONTHS } from '../lib/analytics';
import { arrowPercent, comparedLabel, dayShortMonth, deltaPercent, elapsedDays, monthLong, monthLongYear, todayLocal, weekdayAndDay } from '../lib/format';
import { categories, currency, settings } from '../lib/store';
import { back, route, setQuery } from '../router';
import { analyticsUrl } from '../components/AppTopline';
import CategoryBars from '../components/CategoryBars';
import MonthColumns, { wholeAmount } from '../components/MonthColumns';
import ReportSummary from '../components/ReportSummary';

const BIGGEST = 5;

interface ReportData {
  summary: Summary;
  entries: Entry[];
  history: MonthsSummary;
}

type Load = { status: 'loading' } | { status: 'ready'; month: string; data: ReportData } | { status: 'error' };

export default function Report() {
  const today = todayLocal();
  const language = lang.value;
  const month = reportMonth(route.value.query.get('m'), today);
  const range = monthRange(`${month}-01`);
  const prev = previousRange('month', range);
  const compared = comparableRange(range, prev, today);
  const isCurrent = month === today.slice(0, 7);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    const opts = { signal: ctrl.signal };
    setLoad((l) => (l.status === 'ready' ? l : { status: 'loading' }));
    Promise.all([
      api.summary({ from: range.from, to: range.to, prev_from: compared.from, prev_to: compared.to }, opts),
      api.listEntries(range.from, range.to, opts),
      api.summaryMonths(addMonths(range.from, -(TREND_MONTHS - 1)).slice(0, 7), month, opts),
    ])
      .then(([summary, { entries }, history]) => setLoad({ status: 'ready', month, data: { summary, entries, history } }))
      .catch((err: unknown) => {
        if (!isAbortError(err)) setLoad({ status: 'error' });
      });
    return () => ctrl.abort();
  }, [month, compared.to, attempt]);

  const data = load.status === 'ready' && load.month === month ? load.data : null;
  const title = monthLongYear(range.from, language);
  const comparedWith = comparedLabel('month', prev, compared, language);

  // The PDF's file name comes from the document title.
  const savePdf = () => {
    const before = document.title;
    document.title = `Tally · ${title}`;
    window.addEventListener('afterprint', () => (document.title = before), { once: true });
    window.print();
  };

  return (
    <main class="screen report">
      <header class="topline">
        <button type="button" onClick={() => back(analyticsUrl())}>
          {t('common.back')}
        </button>
        <span>{t('report.title')}</span>
      </header>

      <p class="lbl rp-kicker">{isCurrent ? t('report.inProgress') : t('report.label')}</p>
      <div class="period">
        <button type="button" aria-label={t('report.prev')} onClick={() => setQuery({ m: addMonths(range.from, -1).slice(0, 7) })}>
          ‹
        </button>
        <h1 class="rp-title" aria-live="polite">
          {title}
        </h1>
        <button type="button" aria-label={t('report.next')} disabled={isCurrent} onClick={() => setQuery({ m: addMonths(range.from, 1).slice(0, 7) })}>
          ›
        </button>
      </div>

      {load.status === 'error' ? (
        <p class="ov-note">
          {t('report.loadFailed')}{' '}
          <button type="button" class="link" onClick={() => setAttempt(attempt + 1)}>
            {t('common.tryAgain')}
          </button>
        </p>
      ) : null}
      {data ? <ReportBody data={data} month={month} today={today} title={title} comparedWith={comparedWith} /> : load.status === 'loading' ? <div class="rp-pending" aria-busy="true" /> : null}

      <div class="ov-links rp-actions">
        <button type="button" class="btn primary" onClick={savePdf} disabled={!data}>
          {t('report.pdf')}
        </button>
        <a href={api.exportUrl(range.from, range.to)} download>
          {t('overview.export')}
        </a>
      </div>
    </main>
  );
}

function ReportBody({ data, month, today, title, comparedWith }: { data: ReportData; month: string; today: string; title: string; comparedWith: string }) {
  const language = lang.value;
  const { summary, entries, history } = data;
  const range = { from: summary.from, to: summary.to };
  const total = summary.total_cents;
  if (summary.count === 0) return <p class="ov-note">{t('report.empty', { month: monthLong(range.from, language) })}</p>;

  const budget = settings.value?.budget_cents ?? null;
  const pct = budget && budget > 0 ? percentOf(total, budget) : null;
  const prevTotal = summary.previous?.total_cents ?? 0;
  const delta = deltaPercent(total, prevTotal);
  const days = elapsedDays(range, today);
  const busiest = busiestDay(summary.by_day);
  const diff = total - prevTotal;
  const split = summary.by_category.some((c) => categories.value.some((k) => k.id === c.category_id && k.fixed === true)) ? splitFixed(summary.by_category, categories.value) : null;
  const average = averageCents(history.months, month);

  return (
    <>
      <section class="rp-total">
        <div class="amount-row">
          <span class="big ov-num">{formatAmount(total)}</span>
          <span class="cur">{currency.value}</span>
        </div>
        {pct !== null && budget ? (
          <>
            <div class="meta-row stats">
              <span>{t('report.ofBudget', { pct, budget: formatBudget(budget) })}</span>
            </div>
            <div class="track" aria-hidden="true">
              <div class={`fill${pct >= 100 ? ' acc' : ''}`} style={{ width: `${Math.min(100, pct)}%` }} />
            </div>
          </>
        ) : null}
        <p class="rp-vs">
          {delta !== null
            ? t('report.vsPrev', { delta: arrowPercent(delta), month: comparedWith, diff: `${diff > 0 ? '+' : diff < 0 ? '−' : ''}${formatAmount(Math.abs(diff))}` })
            : t('report.noPrev', { month: comparedWith })}
        </p>
        {split ? <p class="rp-vs">{t('overview.split', { fixed: formatAmount(split.fixed), daily: formatAmount(split.daily) })}</p> : null}
      </section>

      <dl class="rp-stats">
        <div>
          <dt class="lbl">{t('report.entries')}</dt>
          <dd>{summary.count}</dd>
        </div>
        <div>
          <dt class="lbl">{t('report.avgDay')}</dt>
          <dd>{formatAmount(days > 0 ? Math.round(total / days) : 0)}</dd>
        </div>
        {busiest ? (
          <div>
            <dt class="lbl">{t('report.busiest')}</dt>
            <dd>
              {weekdayAndDay(busiest.day, language)}
              <span class="sub">{formatAmount(busiest.total_cents)}</span>
            </dd>
          </div>
        ) : null}
      </dl>

      <ReportSummary key={summary.from} title={title} comparedWith={comparedWith} summary={summary} entries={entries} />

      <h2 class="lbl sec">{t('report.byCategory')}</h2>
      <CategoryBars rows={summary.by_category} totalCents={total} comparedWith={comparedWith} />

      <h2 class="lbl sec">{t('report.biggest')}</h2>
      <ul class="entries rp-biggest">
        {biggestEntries(entries, BIGGEST).map((e) => (
          <li key={e.id}>
            <span class="t">{dayShortMonth(e.occurred_at.slice(0, 10), language)}</span>
            <span>
              <span class="n">{e.description}</span>
              <span class="c">{e.category_name ?? t('common.other')}</span>
            </span>
            <span class="a">{formatAmount(e.amount_cents)}</span>
          </li>
        ))}
      </ul>

      <h2 class="lbl sec">
        {t('report.history')}
        {average !== null ? <span class="sec-aside"> · {t('category.avg', { amount: wholeAmount(average) })}</span> : null}
      </h2>
      <MonthColumns points={monthPoints(history.months)} highlight={month} averageCents={average} />
    </>
  );
}
