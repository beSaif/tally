/**
 * The report's written summary: on request, Gemini (with this device's key) sums up the month in
 * two sentences from the same data "Ask your data" uses, plus the totals it is compared with.
 * Kept per month in this browser until the month's numbers change.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Entry, Summary } from '@shared/api';
import { lang, t } from '../i18n';
import { summaryQuestion } from '../lib/analytics';
import { answerSegments } from '../lib/answer';
import { askData, GeminiError, type GeminiErrorCode } from '../lib/gemini';
import { categoryNames, currency, geminiKey, model } from '../lib/store';
import { ERROR_KEYS } from './AskBox';

type State = { kind: 'idle' } | { kind: 'thinking' } | { kind: 'done'; text: string } | { kind: 'error'; code: GeminiErrorCode | 'offline' };

interface Props {
  title: string;
  comparedWith: string;
  summary: Summary;
  entries: readonly Entry[];
}

const cacheKey = (s: Summary, language: string) => `tally:report-summary:${s.from}:${s.total_cents}:${s.count}:${language}`;

function readCache(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeCache(key: string, text: string): void {
  try {
    localStorage.setItem(key, text);
  } catch {
    // A private window: the summary just is not kept.
  }
}

export default function ReportSummary({ title, comparedWith, summary, entries }: Props) {
  const language = lang.value;
  const key = cacheKey(summary, language);
  const [state, setState] = useState<State>(() => {
    const cached = readCache(key);
    return cached ? { kind: 'done', text: cached } : { kind: 'idle' };
  });
  const inflight = useRef<AbortController | null>(null);
  useEffect(() => () => inflight.current?.abort(), []);

  const apiKey = geminiKey.value;
  if (!apiKey && state.kind !== 'done') return null;

  const write = async () => {
    if (!apiKey) return;
    const ctrl = new AbortController();
    inflight.current = ctrl;
    setState({ kind: 'thinking' });
    try {
      const text = await askData(
        { apiKey, model: model.value },
        summaryQuestion(title, comparedWith, summary, t('common.other')),
        {
          now: new Date(),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          currency: currency.value,
          language,
          categories: categoryNames.value,
          periodLabel: title,
          from: summary.from,
          to: summary.to,
          totalCents: summary.total_cents,
          byCategory: summary.by_category.map((c) => ({ name: c.name ?? t('common.other'), totalCents: c.total_cents })),
          entries: entries.map((e) => ({
            occurred_at: e.occurred_at,
            amount_cents: e.amount_cents,
            currency: e.currency,
            description: e.description,
            category: e.category_name,
            note: e.note,
          })),
        },
        { signal: ctrl.signal },
      );
      if (inflight.current !== ctrl) return;
      writeCache(key, text);
      setState({ kind: 'done', text });
    } catch (err) {
      if (inflight.current !== ctrl) return;
      const code = err instanceof GeminiError ? err.code : 'offline';
      if (code !== 'aborted') setState({ kind: 'error', code });
    }
  };

  const names = [...categoryNames.value, t('common.other')];
  return (
    <section class="rp-summary" aria-live="polite">
      {state.kind === 'done' ? (
        <>
          <h2 class="lbl sec">{t('report.summaryLabel')}</h2>
          <p class="rp-summary-text">
            {answerSegments(state.text, names).map((seg, i) =>
              seg.kind === 'text' ? seg.text : <span key={i} class={seg.kind === 'amount' ? 'mono' : 'acc'}>{seg.text}</span>,
            )}
          </p>
        </>
      ) : null}
      {state.kind === 'thinking' ? (
        <div class="thinking-dots" role="status" aria-label={t('report.summaryThinking')}>
          <i />
          <i />
          <i />
        </div>
      ) : null}
      {state.kind === 'idle' || state.kind === 'error' ? (
        <button type="button" class="pill rp-summarize" onClick={() => void write()}>
          ✦ {t('report.summarize')}
        </button>
      ) : null}
      {state.kind === 'error' ? <p class="err line">{t(ERROR_KEYS[state.code], { model: model.value })}</p> : null}
    </section>
  );
}
