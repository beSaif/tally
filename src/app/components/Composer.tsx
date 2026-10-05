/**
 * The bottom input bar (spec §3.4): text (Enter sends), camera, and a mic that records on
 * pointerdown. Released within 300ms → tap mode (tap again to stop); held → release sends;
 * dragging up more than 80px before release cancels. The hold/tap decision lives in lib/capture
 * (releaseRecording), which also covers a press the microphone permission prompt takes away.
 */
import { useEffect, useRef } from 'preact/hooks';
import { t } from '../i18n';
import {
  capture,
  composerFocusRequest,
  composerText,
  finishRecording,
  keepListening,
  photoPickRequest,
  releaseRecording,
  setCancelArmed,
  startRecording,
  submitPhoto,
  submitText,
} from '../lib/capture';
import { IconCam, IconMic, IconSend } from './Icons';

const CANCEL_PX = 80;

export default function Composer() {
  const inputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const press = useRef<{ id: number; y: number; at: number } | null>(null);
  const text = composerText.value;
  const state = capture.value;
  const busy = state.kind !== 'idle';

  useEffect(() => {
    if (composerFocusRequest.value === 0) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [composerFocusRequest.value]);

  useEffect(() => {
    if (photoPickRequest.value > 0) fileRef.current?.click();
  }, [photoPickRequest.value]);

  const send = () => {
    if (composerText.value.trim()) submitText(composerText.value);
  };

  const onMicDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const s = capture.value;
    if (s.kind === 'recording') {
      if (s.gesture === 'tap') void finishRecording(true); // "tap the mic again"
      return;
    }
    if (s.kind !== 'idle') return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    press.current = { id: e.pointerId, y: e.clientY, at: performance.now() };
    void startRecording('pending');
  };

  const onMicMove = (e: PointerEvent) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    setCancelArmed(p.y - e.clientY > CANCEL_PX);
  };

  const onMicUp = (e: PointerEvent) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    press.current = null;
    releaseRecording(performance.now() - p.at);
  };

  // The system took the touch (a permission prompt, a call, …): nothing was said to be cancelled.
  const onMicCancel = (e: PointerEvent) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    press.current = null;
    keepListening();
  };

  // Keyboard activation (Enter/Space) has no pointer: toggle tap-mode recording.
  const onMicClick = (e: MouseEvent) => {
    if (e.detail !== 0) return;
    const s = capture.value;
    if (s.kind === 'recording') void finishRecording(true);
    else if (s.kind === 'idle') void startRecording('tap');
  };

  const hasText = text.trim().length > 0;

  return (
    <div class="composer">
      <form
        class="cbox"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input
          ref={inputRef}
          type="text"
          name="expense"
          value={text}
          placeholder={t('composer.placeholder')}
          aria-label={t('composer.label')}
          autocomplete="off"
          autocapitalize="sentences"
          enterkeyhint="send"
          disabled={busy}
          onInput={(e) => (composerText.value = e.currentTarget.value)}
        />
        <button type="button" class="ibtn ghost" aria-label={t('composer.camera')} disabled={busy} onClick={() => fileRef.current?.click()}>
          <IconCam />
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          class="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = '';
            if (file) submitPhoto(file);
          }}
        />
        {hasText ? (
          <button type="submit" class="ibtn dark" aria-label={t('composer.send')} disabled={busy}>
            <IconSend />
          </button>
        ) : (
          <button
            type="button"
            class={`ibtn mic ${state.kind === 'recording' ? 'acc' : 'dark'}`}
            aria-label={t('composer.mic')}
            aria-pressed={state.kind === 'recording'}
            onPointerDown={onMicDown}
            onPointerMove={onMicMove}
            onPointerUp={onMicUp}
            onPointerCancel={onMicCancel}
            onClick={onMicClick}
            onContextMenu={(e) => e.preventDefault()}
          >
            <IconMic />
          </button>
        )}
      </form>
    </div>
  );
}
