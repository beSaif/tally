import type { SummaryCategory } from '@shared/api';
import { formatAmount } from '@shared/money';
import { t } from '../i18n';
import { deltaPercent, signedPercent } from '../lib/format';

/** Category bars (design A.3): sorted desc, top one in the accent, widths relative to the top. */
export default function CategoryBars({ rows }: { rows: readonly SummaryCategory[] }) {
  const sorted = [...rows].sort((a, b) => b.total_cents - a.total_cents);
  const top = sorted[0]?.total_cents ?? 0;
  return (
    <ul class="bars">
      {sorted.map((c, i) => {
        const width = top > 0 ? Math.max(1, Math.round((c.total_cents / top) * 100)) : 0;
        const delta = deltaPercent(c.total_cents, c.prev_total_cents);
        const name = c.name ?? t('common.other');
        return (
          <li key={c.category_id ?? 'other'}>
            <div class="top">
              <b>
                {name}
                {delta !== null ? (
                  <span class="delta" title={t('overview.deltaLabel', { delta: signedPercent(delta) })}>
                    {t('overview.delta', { delta: signedPercent(delta) })}
                  </span>
                ) : null}
              </b>
              <span>{formatAmount(c.total_cents)}</span>
            </div>
            <div class="track" aria-hidden="true">
              <div class={`fill${i === 0 ? ' acc' : ''}`} style={{ width: `${width}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
