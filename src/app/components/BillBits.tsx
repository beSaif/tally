/** Small pieces every bill form shares: how often it comes back, and what happens when it is due. */
import { useId } from 'preact/hooks';
import type { BillMode, Cadence } from '@shared/api';
import { CADENCES } from '@shared/bills';
import { t } from '../i18n';
import { IconRepeat } from './Icons';

/** "Log it for me" | "Ask me first", with a line on what that means. */
export function ModeSwitch({ value, onChange }: { value: BillMode; onChange: (m: BillMode) => void }) {
  const id = useId();
  return (
    <div class="bill-mode">
      <div class="lbl" id={id}>
        {t('bills.whenDue')}
      </div>
      <div class="seg2" role="radiogroup" aria-labelledby={id}>
        {(['auto', 'ask'] as const).map((m) => (
          <button key={m} type="button" role="radio" aria-checked={value === m} class={value === m ? 'on' : ''} onClick={() => onChange(m)}>
            {t(m === 'auto' ? 'bills.mode.auto' : 'bills.mode.ask')}
          </button>
        ))}
      </div>
      <p class="note">{t(value === 'auto' ? 'bills.mode.autoHint' : 'bills.mode.askHint')}</p>
    </div>
  );
}

export const cadenceName = (c: Cadence): string => t(`bills.cadence.${c}`);

/** Radio chips for the beat; `once` adds "Just once" (a one-off expense) in front. */
export function CadenceChips({ value, onChange, once, labelledBy }: { value: Cadence | null; onChange: (c: Cadence | null) => void; once?: boolean; labelledBy?: string }) {
  const options: Array<Cadence | null> = once ? [null, ...CADENCES] : [...CADENCES];
  return (
    <div class="chips" role="radiogroup" aria-labelledby={labelledBy}>
      {options.map((c) => (
        <button key={c ?? 'once'} type="button" role="radio" aria-checked={value === c} class={`pill${value === c ? ' on' : ''}`} onClick={() => onChange(c)}>
          {c ? cadenceName(c) : t('bills.once')}
        </button>
      ))}
    </div>
  );
}

/** The repeat glyph inline in a caption. */
export function RepeatMark() {
  return (
    <span class="repeat-mark" aria-hidden="true">
      <IconRepeat />
    </span>
  );
}
