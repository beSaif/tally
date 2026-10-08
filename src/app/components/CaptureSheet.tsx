/**
 * The capture sheet (design A.2 + C.2, spec §3.5): recording → thinking → result (single or
 * batch, with edit mode) | nothing parsed | error.
 */
import { formatAmount, parseAmount } from '@shared/money';
import { t } from '../i18n';
import {
  cancelEditing,
  capture,
  closeCapture,
  editAll,
  editDraft,
  elapsedMs,
  finishRecording,
  levels,
  retryCapture,
  saveCapture,
  toggleDraft,
  typeInstead,
  updateDraft,
  type CaptureErrorCode,
  type CaptureInput,
  type CaptureState,
  type Draft,
  type ResultState,
} from '../lib/capture';
import { frozenWave, noteWave } from '../lib/bars';
import { formatDuration, todayLocal } from '../lib/format';
import { categories, currency, model } from '../lib/store';
import { navigate } from '../router';
import { CompactFields, EntryFields, EntryReadout } from './EntryFields';
import { IconClose, IconOk, IconStop } from './Icons';
import Sheet from './Sheet';
import Wave from './Wave';

export default function CaptureSheet() {
  const s = capture.value;
  if (s.kind === 'idle') return null;
  const focusKey = s.kind === 'recording' ? `rec-${s.gesture}` : s.kind === 'result' ? `res-${s.editing.length > 0}` : s.kind;
  return (
    <Sheet label={t('capture.sheet')} onClose={closeCapture} focusKey={focusKey} class={`capture ${s.kind}`}>
      {s.kind === 'recording' ? <Recording state={s} /> : null}
      {s.kind === 'thinking' ? <Thinking input={s.input} /> : null}
      {s.kind === 'result' ? <Result state={s} /> : null}
      {s.kind === 'empty' ? <Empty input={s.input} transcript={s.transcript} reply={s.reply} /> : null}
      {s.kind === 'error' ? <Failure input={s.input} code={s.code} /> : null}
    </Sheet>
  );
}

function CloseButton() {
  return (
    <button type="button" class="ibtn ghost sm" aria-label={t('common.close')} onClick={closeCapture}>
      <IconClose />
    </button>
  );
}

function Recording({ state }: { state: Extract<CaptureState, { kind: 'recording' }> }) {
  const tap = state.gesture === 'tap';
  const hint = tap ? t('capture.tapToStop') : t('capture.releaseToSend');
  return (
    <>
      <div class="sheet-head">
        <span class="lbl acc state">
          <span class="dot" />
          {t('capture.listening', { time: formatDuration(elapsedMs.value) })}
        </span>
        <span class="lbl" aria-live="polite">
          {hint}
        </span>
      </div>
      <div class="wave-wrap">
        <Wave values={levels.value} tone="live" />
      </div>
      {tap ? (
        <div class="btns">
          <button type="button" class="btn" onClick={() => void finishRecording(false)}>
            {t('common.cancel')}
          </button>
          <button type="button" class="btn primary with-icon" onClick={() => void finishRecording(true)}>
            <IconStop />
            {t('capture.stopSend')}
          </button>
        </div>
      ) : null}
    </>
  );
}

/** What the person gave us: the typed text, the transcript, or the receipt thumbnail. */
function Source({ input, transcript, label, big }: { input: CaptureInput; transcript?: string; label?: boolean; big?: boolean }) {
  if (input.mode === 'photo') {
    return (
      <div class="source">
        {label ? <div class="lbl you">{t('capture.photo')}</div> : null}
        <img class="thumb" src={input.thumbUrl} alt={t('capture.photo')} />
      </div>
    );
  }
  if (input.mode === 'text') {
    return (
      <div class="source">
        {label ? <div class="lbl you">{t('capture.youWrote')}</div> : null}
        <p class={`quote ink${big ? ' big-quote' : ''}`}>{input.text}</p>
      </div>
    );
  }
  return transcript ? (
    <div class="source">
      <p class="quote ink">{t('capture.quote', { text: transcript })}</p>
    </div>
  ) : null;
}

/** A finished voice note keeps the design's header + wave, with an honest label (no longer live). */
function VoiceHead({ input }: { input: CaptureInput | null }) {
  if (input?.mode !== 'voice') return null;
  return (
    <>
      <div class="sheet-head">
        <span class="lbl">{t('capture.voiceNote', { time: formatDuration(input.durationMs) })}</span>
        <CloseButton />
      </div>
      <div class="wave-wrap">
        <Wave values={noteWave(input.wave)} tone="frozen" />
      </div>
    </>
  );
}

function Thinking({ input }: { input: CaptureInput }) {
  return (
    <>
      <div class="sheet-head">
        <span class="lbl acc state" role="status">
          <span class="dot pulse" />
          {input.mode === 'voice' ? t('capture.thinkingListen') : t('capture.thinkingRead')}
        </span>
        <CloseButton />
      </div>
      {input.mode === 'voice' ? (
        <div class="wave-wrap">
          <Wave values={frozenWave(input.wave)} tone="frozen" />
        </div>
      ) : (
        <Source input={input} />
      )}
      <div class="skeleton" aria-hidden="true">
        <i style={{ width: '74%' }} />
        <i style={{ width: '52%' }} />
        <i style={{ width: '63%' }} />
      </div>
    </>
  );
}

function Result({ state }: { state: ResultState }) {
  return state.drafts.length === 1 ? <Single state={state} /> : <Batch state={state} />;
}

function Single({ state }: { state: ResultState }) {
  const draft = state.drafts[0] as Draft;
  const editing = state.editing.length > 0;
  return (
    <>
      <VoiceHead input={state.input} />
      <Source input={state.input} transcript={state.transcript} label />
      <div class="parsed-row">
        <span class="lbl">{t('capture.parsed')}</span>
        <span class="pill">
          <span class="dot" />
          {t('capture.ai')}
        </span>
      </div>
      {editing ? <EntryFields draft={draft} onChange={(p) => updateDraft(draft.key, p)} /> : <EntryReadout draft={draft} today={todayLocal()} />}
      {state.error ? (
        <p class="err line" role="alert">
          {t(state.error)}
        </p>
      ) : null}
      <div class="btns">
        {editing ? (
          <button type="button" class="btn" onClick={cancelEditing} disabled={state.saving}>
            {t('common.cancel')}
          </button>
        ) : (
          <button type="button" class="btn" onClick={editAll}>
            {t('common.edit')}
          </button>
        )}
        <button type="button" class="btn primary" onClick={() => void saveCapture()} disabled={state.saving}>
          {state.saving ? '…' : t('common.save')}
        </button>
      </div>
    </>
  );
}

function Batch({ state }: { state: ResultState }) {
  const chosen = state.drafts.filter((d) => d.checked);
  const total = chosen.reduce((sum, d) => sum + (parseAmount(d.amount) ?? 0), 0);
  // One row opened by a tap still offers "Edit" (all rows); Cancel appears once all are open.
  const allEditing = state.editing.length === state.drafts.length;
  return (
    <>
      <VoiceHead input={state.input} />
      <Source input={state.input} transcript={state.transcript} label big />
      <div class="parsed-row found">
        <span class="lbl">{t('capture.found', { count: state.drafts.length })}</span>
        <span class="pill">
          <span class="dot" />
          {t('capture.gemini')}
        </span>
      </div>
      <ul class="feed">
        {state.drafts.map((d) => (
          <BatchRow key={d.key} draft={d} editing={state.editing.includes(d.key)} />
        ))}
      </ul>
      <div class="total-row">
        <span class="lbl">{t('capture.total')}</span>
        <span class="mono total">
          {formatAmount(total)} {currency.value}
        </span>
      </div>
      {state.error ? (
        <p class="err line" role="alert">
          {t(state.error)}
        </p>
      ) : null}
      <div class="btns">
        {allEditing ? (
          <button type="button" class="btn" onClick={cancelEditing} disabled={state.saving}>
            {t('common.cancel')}
          </button>
        ) : (
          <button type="button" class="btn" onClick={editAll}>
            {t('common.edit')}
          </button>
        )}
        <button type="button" class="btn primary" onClick={() => void saveCapture()} disabled={state.saving || chosen.length === 0}>
          {state.saving ? '…' : t('capture.log', { count: chosen.length })}
        </button>
      </div>
    </>
  );
}

function BatchRow({ draft, editing }: { draft: Draft; editing: boolean }) {
  const cents = parseAmount(draft.amount) ?? 0;
  const category = (draft.categoryId && categories.value.find((c) => c.id === draft.categoryId)?.name) || t('common.other');
  const check = (
    <button
      type="button"
      class={`check${draft.checked ? '' : ' off'}`}
      role="checkbox"
      aria-checked={draft.checked}
      aria-label={t('capture.include', { name: draft.description })}
      onClick={() => toggleDraft(draft.key)}
    >
      {draft.checked ? <IconOk /> : null}
    </button>
  );
  if (editing) {
    return (
      <li class={`feed-edit${draft.checked ? '' : ' off'}`}>
        {check}
        <CompactFields draft={draft} onChange={(p) => updateDraft(draft.key, p)} />
      </li>
    );
  }
  return (
    <li class={draft.checked ? '' : 'off'}>
      {check}
      <button type="button" class="feed-main" aria-label={t('capture.editRow', { name: draft.description })} onClick={() => editDraft(draft.key)}>
        <span class="a">{formatAmount(cents)}</span>
        <span>
          <span class="n">{draft.description}</span>
          <span class="c">
            {category}
            {draft.currency !== currency.value ? ` · ${draft.currency}` : ''}
            {draft.note ? ` · ${draft.note}` : ''}
          </span>
        </span>
      </button>
    </li>
  );
}

function Empty({ input, transcript, reply }: { input: CaptureInput; transcript: string; reply: string | null }) {
  return (
    <>
      <VoiceHead input={input} />
      <Source input={input} transcript={transcript} label />
      <p class="reply">{reply || t('capture.noReply')}</p>
      <div class="btns">
        <button type="button" class="btn" onClick={typeInstead}>
          {t('capture.typeIt')}
        </button>
        <button type="button" class="btn primary" onClick={retryCapture}>
          {t('common.tryAgain')}
        </button>
      </div>
    </>
  );
}

function errorText(code: CaptureErrorCode): string {
  switch (code) {
    case 'mic':
      return t('capture.micError');
    case 'micDenied':
      return t('capture.micDenied');
    case 'tooShort':
      return t('capture.tooShort');
    case 'invalid_key':
      return t('gemini.invalid_key');
    case 'quota':
      return t('gemini.quota');
    case 'network':
      return t('gemini.network');
    case 'bad_response':
      return t('gemini.bad_response');
    case 'model_not_found':
      return t('gemini.model_not_found', { model: model.value });
    default:
      return t('gemini.unknown');
  }
}

function Failure({ input, code }: { input: CaptureInput | null; code: CaptureErrorCode }) {
  const toSettings = code === 'invalid_key' || code === 'model_not_found';
  return (
    <>
      <VoiceHead input={input} />
      {input && input.mode !== 'voice' ? <Source input={input} label /> : null}
      <p class="err big-err" role="alert">
        {errorText(code)}
      </p>
      {toSettings ? (
        <a
          class="link err-link"
          href="/settings"
          onClick={(e) => {
            e.preventDefault();
            closeCapture();
            navigate('/settings');
          }}
        >
          {t('gemini.openSettings')}
        </a>
      ) : null}
      <div class="btns">
        <button type="button" class="btn" onClick={closeCapture}>
          {t('common.close')}
        </button>
        <button type="button" class="btn primary" onClick={retryCapture}>
          {t('common.tryAgain')}
        </button>
      </div>
    </>
  );
}
