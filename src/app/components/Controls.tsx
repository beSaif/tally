/** Small form controls in the design's language: pill toggle, select with ▾, multi-line headline. */
import type { ComponentChildren } from 'preact';
import { t } from '../i18n';

/** ON/OFF switch drawn as a `.pill` (spec §3.8). */
export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      class={`pill toggle${checked ? ' on' : ''}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      {checked ? t('common.on') : t('common.off')}
    </button>
  );
}

export interface Option {
  value: string;
  label: string;
}

/** Native select (good on phones) dressed as the design's "CHF — Swiss franc ▾" row. */
export function Select({ value, options, onChange, label, id }: { value: string; options: Option[]; onChange: (v: string) => void; label: string; id?: string }) {
  return (
    <span class="sel">
      <select id={id} aria-label={label} value={value} onChange={(e) => onChange(e.currentTarget.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span class="mono caret" aria-hidden="true">
        ▾
      </span>
    </span>
  );
}

/** Headline with the dictionary's forced line breaks ("Bring your\nown key."). */
export function Lines({ text }: { text: string }) {
  const parts = text.split('\n');
  return (
    <>
      {parts.map((p, i) => (
        <span key={i}>
          {p}
          {i < parts.length - 1 ? <br /> : null}
        </span>
      ))}
    </>
  );
}

export function Section({ title, children, id }: { title: string; children?: ComponentChildren; id?: string }) {
  return (
    <section class="set-section" aria-labelledby={id}>
      <h2 class="section" id={id}>
        <span>{title}</span>
      </h2>
      {children}
    </section>
  );
}
