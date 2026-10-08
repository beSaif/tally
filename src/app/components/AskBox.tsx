/**
 * "Ask your data" (design C.3, spec §3.6): a question about the visible period goes to Gemini with
 * that period's entries; the latest answer renders at the end of the page with amounts in mono and
 * the first category mentioned in the accent colour. The box itself is docked at the bottom, like
 * the ledger's composer. ERROR_KEYS also serves the report's summary.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Summary } from '@shared/api';
import type { DayRange } from '@shared/dates';
import { lang, t } from '../i18n';
import { answerSegments } from '../lib/answer';
import { api, isAbortError } from '../lib/api';
import { askData, GeminiError, type GeminiErrorCode } from '../lib/gemini';
import { sumCents, totalsByCategory } from '../lib/format';
import { categoryNames, currency, geminiKey, model } from '../lib/store';
import { linkTo } from '../router';
import { IconSend } from './Icons';

type AskState =
  | { kind: 'idle' }
  | { kind: 'thinking'; question: string }
  | { kind: 'answer'; question: string; text: string }
  | { kind: 'error'; question: string; code: GeminiErrorCode | 'offline' };

export const ERROR_KEYS = {
  invalid_key: 'gemini.invalid_key',
  model_not_found: 'gemini.model_not_found',
  quota: 'gemini.quota',
  network: 'gemini.network',
  bad_response: 'gemini.bad_response',
  unknown: 'gemini.unknown',
  aborted: 'gemini.unknown',
  offline: 'toast.offline',
} as const;

export default function AskBox({ periodLabel, range, summary }: { periodLabel: string; range: DayRange; summary: Summary | null }) {
  const [question, setQuestion] = useState('');
  const [state, setState] = useState<AskState>({ kind: 'idle' });
  const inflight = useRef<AbortController | null>(null);
  const answerRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => inflight.current?.abort(), []);

  // The answer lands at the end of the page, behind the docked box: bring it into view.
  useEffect(() => {
    if (state.kind !== 'idle') answerRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [state.kind]);

  const apiKey = geminiKey.value;
  if (!apiKey) {
    return (
      <p class="ask-nokey">
        <a class="link" href="/settings" onClick={linkTo('/settings')}>
          {t('overview.askNoKey')}
        </a>
      </p>
    );
  }

  const ask = async () => {
    const q = question.trim();
    if (!q) return;
    inflight.current?.abort();
    const ctrl = new AbortController();
    inflight.current = ctrl;
    setState({ kind: 'thinking', question: q });
    try {
      const { entries } = await api.listEntries(range.from, range.to, { signal: ctrl.signal });
      const text = await askData(
        { apiKey, model: model.value },
        q,
        {
          now: new Date(),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          currency: currency.value,
          language: lang.value,
          categories: categoryNames.value,
          periodLabel,
          from: range.from,
          to: range.to,
          // Until the period's summary has loaded, the entries just fetched give the same totals.
          totalCents: summary?.total_cents ?? sumCents(entries),
          byCategory: (summary ? summary.by_category.map((c) => ({ name: c.name, totalCents: c.total_cents })) : totalsByCategory(entries)).map((c) => ({
            name: c.name ?? t('common.other'),
            totalCents: c.totalCents,
          })),
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
      inflight.current = null;
      setState({ kind: 'answer', question: q, text: text.trim() });
      setQuestion('');
    } catch (err) {
      if (inflight.current !== ctrl || isAbortError(err)) return;
      inflight.current = null;
      const code = err instanceof GeminiError ? err.code : (err as { code?: string } | null)?.code === 'offline' ? 'offline' : 'unknown';
      if (code === 'aborted') return;
      setState({ kind: 'error', question: q, code });
    }
  };

  const names = [...categoryNames.value, t('common.other')];

  return (
    <div class="ask">
      {state.kind !== 'idle' ? (
        <div class="answer-block" aria-live="polite" ref={answerRef}>
          <div class="lbl">{state.question}</div>
          {state.kind === 'thinking' ? (
            <div class="thinking-dots" role="status" aria-label={t('overview.askThinking')}>
              <i />
              <i />
              <i />
            </div>
          ) : null}
          {state.kind === 'answer' ? (
            <p class="answer">
              {answerSegments(state.text, names).map((seg, i) =>
                seg.kind === 'text' ? seg.text : <span key={i} class={seg.kind === 'amount' ? 'mono' : 'acc'}>{seg.text}</span>,
              )}
            </p>
          ) : null}
          {state.kind === 'error' ? <p class="err line">{t(ERROR_KEYS[state.code], { model: model.value })}</p> : null}
        </div>
      ) : null}
      <div class="composer">
        <form
          class="cbox ask-box"
          onSubmit={(e) => {
            e.preventDefault();
            void ask();
          }}
        >
          <input
            type="text"
            value={question}
            placeholder={t('overview.askPlaceholder')}
            aria-label={t('overview.askLabel')}
            autocomplete="off"
            enterkeyhint="send"
            onInput={(e) => setQuestion(e.currentTarget.value)}
          />
          <button type="submit" class="ibtn dark" aria-label={t('overview.ask')} disabled={!question.trim() || state.kind === 'thinking'}>
            <IconSend />
          </button>
        </form>
      </div>
    </div>
  );
}
