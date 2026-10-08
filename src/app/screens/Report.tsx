/**
 * Monthly report (`/report?m=YYYY-MM`): a month's total against the budget and the month before,
 * its categories, biggest expenses and the six months up to it. The first-of-month notification
 * opens last month's; "Save as PDF" prints it (print styles drop the app chrome).
 */
import { useEffect, useState } from 'preact/hooks';
import type { Entry, MonthsSummary, Summary } from '@shared/api';
import { addMonths, monthRange, previousRange } from '@shared/dates';
import { formatAmount, formatBudget, percentOf } from '@shared/money';
import { lang, t } from '../i18n';
import { api, isAbortError } from '../lib/api';
import { biggestEntries, busiestDay, monthPoints, reportMonth, TREND_MONTHS } from '../lib/analytics';
import { dayShortMonth, deltaPercent, elapsedDays, monthLong, monthLongYear, signedPercent, todayLocal, weekdayAndDay } from '../lib/format';
import { currency, settings } from '../lib/store';
import { back, route, setQuery } from '../router';
import CategoryBars from '../components/CategoryBars';
import MonthColumns from '../components/MonthColumns';

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
  const isCurrent = month === today.slice(0, 7);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    const opts = { signal: ctrl.signal };
    setLoad((l) => (l.status === 'ready' ? l : { status: 'loading' }));
    Promise.all([
      api.summary({ from: range.from, to: range.to, prev_from: prev.from, prev_to: prev.to }, opts),
      api.listEntries(range.from, range.to, opts),
      api.summaryMonths(addMonths(range.from, -(TREND_MONTHS - 1)).slice(0, 7), month, opts),
    ])
      .then(([summary, { entries }, history]) => setLoad({ status: 'ready', month, data: { summary, entries, history } }))
      .catch((err: unknown) => {
        if (!isAbortError(err)) setLoad({ status: 'error' });
      });
    return () => ctrl.abort();
  }, [month, attempt]);

  const data = load.status === 'ready' && load.month === month ? load.data : null;
  const title = monthLongYear(range.from, language);
  const prevName = monthLong(prev.from, language);

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
        <button type="button" onClick={() => back('/overview')}>
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
      {data ? <ReportBody data={data} month={month} today={today} prevName={prevName} /> : load.status === 'loading' ? <div class="rp-pending" aria-busy="true" /> : null}

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

function ReportBody({ data, month, today, prevName }: { data: ReportData; month: string; today: string; prevName: string }) {
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
            ? t('report.vsPrev', { delta: signedPercent(delta), month: prevName, diff: `${diff > 0 ? '+' : diff < 0 ? '−' : ''}${formatAmount(Math.abs(diff))}` })
            : t('report.noPrev', { month: prevName })}
        </p>
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

      <h2 class="lbl sec">{t('report.byCategory')}</h2>
      <CategoryBars rows={summary.by_category} totalCents={total} />

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

      <h2 class="lbl sec">{t('report.history')}</h2>
      <MonthColumns points={monthPoints(history.months)} highlight={month} />
    </>
  );
}
