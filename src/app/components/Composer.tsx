/**
 * The bottom input bar (spec §3.4): text (Enter sends), camera, and a mic. Pressing the mic starts
 * listening; letting go does nothing: the sheet's "Stop & send" (or the mic again) ends it.
 */
import { useEffect, useRef } from 'preact/hooks';
import { t } from '../i18n';
import {
  capture,
  composerFocusRequest,
  composerText,
  finishRecording,
  photoPickRequest,
  startRecording,
  submitPhoto,
  submitText,
} from '../lib/capture';
import { IconCam, IconMic, IconSend } from './Icons';

/** `placeholder` overrides the usual hint (the bills calendar names the picked day). */
export default function Composer({ placeholder }: { placeholder?: string } = {}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
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

  const toggleMic = () => {
    const s = capture.value;
    if (s.kind === 'recording') void finishRecording(true); // "tap the mic again"
    else if (s.kind === 'idle') void startRecording();
  };

  // Starts on the press itself (no wait for the release, which does nothing): the sheet with
  // Cancel / Stop & send opens at once. Inside this gesture the microphone may be asked for.
  const onMicDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    toggleMic();
  };

  // Keyboard activation (Enter/Space) has no pointer; a pointer's own click was handled on pointerdown.
  const onMicClick = (e: MouseEvent) => {
    if (e.detail === 0) toggleMic();
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
          placeholder={placeholder ?? t('composer.placeholder')}
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
          // No `capture`: iOS and Android then offer the camera and the photo library both.
          accept="image/*"
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
