/**
 * Gemini key input with the live check (design 00.1): checks 600ms after typing stops and at once on
 * paste; once valid it shows the key masked as `AIza••••••••••••••Qx4`.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../i18n';
import { checkKey, type GeminiErrorCode } from '../lib/gemini';

export type KeyStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'ok'; model: string }
  | { kind: 'error'; code: GeminiErrorCode };

/** "AIza••••••••••••••Qx4": first 4 + bullets + last 3 (fewer bullets where space is short). */
export function maskKey(key: string, bullets = 14): string {
  if (key.length <= 8) return '•'.repeat(key.length);
  return `${key.slice(0, 4)}${'•'.repeat(bullets)}${key.slice(-3)}`;
}

/** Typing pauses this long before a check, so Google is asked once per edit, not per keystroke. */
const CHECK_DELAY_MS = 600;

/**
 * Key text + check status. A key given at mount is checked at once; after that the check re-runs
 * when the key or the model changes, once typing pauses.
 */
export function useKeyCheck(model: string, initial = '') {
  const [key, setKeyState] = useState(initial);
  const [status, setStatus] = useState<KeyStatus>({ kind: 'idle' });
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const inflight = useRef<AbortController | null>(null);
  const mounted = useRef(false);

  const run = async (value: string) => {
    clearTimeout(timer.current);
    inflight.current?.abort();
    const trimmed = value.trim();
    if (!trimmed) {
      setStatus({ kind: 'idle' });
      return;
    }
    const ctrl = new AbortController();
    inflight.current = ctrl;
    setStatus({ kind: 'checking' });
    let result: Awaited<ReturnType<typeof checkKey>>;
    try {
      result = await checkKey({ apiKey: trimmed, model }, { signal: ctrl.signal });
    } catch (err) {
      const code = (err as { code?: GeminiErrorCode } | null)?.code ?? 'unknown';
      result = { ok: false, code, message: String(err) };
    }
    if (inflight.current !== ctrl) return;
    inflight.current = null;
    if (result.ok) setStatus({ kind: 'ok', model: result.model || model });
    else if (result.code !== 'aborted') setStatus({ kind: 'error', code: result.code });
  };

  const setKey = (value: string, opts: { now?: boolean } = {}) => {
    setKeyState(value);
    clearTimeout(timer.current);
    inflight.current?.abort();
    if (!value.trim()) {
      setStatus({ kind: 'idle' });
      return;
    }
    if (opts.now) void run(value);
    else {
      setStatus({ kind: 'idle' });
      timer.current = setTimeout(() => void run(value), CHECK_DELAY_MS);
    }
  };

  useEffect(() => {
    if (!mounted.current) {
      // Mount: a saved key (Settings) shows its status right away, once.
      mounted.current = true;
      if (key.trim()) void run(key);
      return;
    }
    // The model is being typed (Settings): wait for a pause, as for the key itself.
    if (key.trim()) setKey(key);
  }, [model]);

  useEffect(
    () => () => {
      clearTimeout(timer.current);
      inflight.current?.abort();
    },
    [],
  );

  return { key, setKey, status };
}

export function KeyStatusLine({ status, model }: { status: KeyStatus; model: string }) {
  if (status.kind === 'idle') return <div class="status" role="status" />;
  let text: string;
  let dot: string;
  if (status.kind === 'checking') {
    text = t('key.checking');
    dot = 'dot pulse';
  } else if (status.kind === 'ok') {
    text = t('key.ok', { model: status.model });
    dot = 'dot ok';
  } else {
    dot = 'dot err';
    text =
      status.code === 'invalid_key'
        ? t('key.invalid_key')
        : status.code === 'model_not_found'
          ? t('key.model_not_found', { model })
          : status.code === 'network'
            ? t('key.network')
            : status.code === 'quota'
              ? t('key.quota')
              : t('key.other');
  }
  return (
    <div class="status" role="status">
      <span class={dot} />
      {text}
    </div>
  );
}

export default function KeyField({
  value,
  status,
  onChange,
  label,
  autoFocus,
}: {
  value: string;
  status: KeyStatus;
  onChange: (value: string, opts?: { now?: boolean }) => void;
  label: string;
  autoFocus?: boolean;
}) {
  const [editing, setEditing] = useState(status.kind !== 'ok');
  const inputRef = useRef<HTMLInputElement>(null);
  const showMasked = status.kind === 'ok' && !editing && value.length > 0;

  useEffect(() => {
    if (editing && autoFocus) inputRef.current?.focus();
  }, [editing]);

  const paste = async () => {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (text) {
        setEditing(false);
        onChange(text, { now: true });
        return;
      }
    } catch {
      /* clipboard read refused: let the person paste by hand */
    }
    setEditing(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  return (
    <div class="field key-field">
      <div class="v">
        {showMasked ? (
          <button type="button" class="masked" aria-label={label} onClick={() => setEditing(true)}>
            {maskKey(value.trim())}
          </button>
        ) : (
          <input
            ref={inputRef}
            class="mono"
            type="password"
            aria-label={label}
            autocomplete="off"
            autocapitalize="off"
            spellcheck={false}
            data-1p-ignore
            data-lpignore="true"
            placeholder={t('setup.keyPlaceholder')}
            value={value}
            autoFocus={autoFocus}
            onInput={(e) => onChange(e.currentTarget.value)}
            onPaste={(e) => {
              const text = e.clipboardData?.getData('text')?.trim();
              if (text) {
                e.preventDefault();
                setEditing(false);
                onChange(text, { now: true });
              }
            }}
            onBlur={() => setEditing(false)}
          />
        )}
        <button type="button" class="pill" onClick={() => void paste()}>
          {t('common.paste')}
        </button>
      </div>
    </div>
  );
}
