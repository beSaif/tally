import type { SummaryCategory } from '@shared/api';
import { formatAmount, percentOf } from '@shared/money';
import { t } from '../i18n';
import { deltaPercent, signedPercent } from '../lib/format';

interface Props {
  rows: readonly SummaryCategory[];
  /** The period's total, for each category's share. */
  totalCents: number;
  /** Makes each row a button (Analytics' drill-down); the report leaves it out. */
  onOpen?: (row: SummaryCategory) => void;
}

/** Category bars (design A.3): sorted desc, top one in the accent, widths relative to the top, share of the total. */
export default function CategoryBars({ rows, totalCents, onOpen }: Props) {
  const sorted = [...rows].sort((a, b) => b.total_cents - a.total_cents);
  const top = sorted[0]?.total_cents ?? 0;
  return (
    <ul class={`bars${onOpen ? ' open' : ''}`}>
      {sorted.map((c, i) => {
        const width = top > 0 ? Math.max(1, Math.round((c.total_cents / top) * 100)) : 0;
        const delta = deltaPercent(c.total_cents, c.prev_total_cents);
        const share = percentOf(c.total_cents, totalCents);
        const name = c.name ?? t('common.other');
        const body = (
          <>
            <span class="top">
              <b>
                {name}
                {delta !== null ? (
                  <span class="delta" title={t('overview.deltaLabel', { delta: signedPercent(delta) })}>
                    {t('overview.delta', { delta: signedPercent(delta) })}
                  </span>
                ) : null}
              </b>
              <span>
                <span class="share" title={t('overview.shareLabel', { share })}>
                  {t('overview.share', { share })}
                </span>
                {formatAmount(c.total_cents)}
                {onOpen ? <span class="chev" aria-hidden="true">›</span> : null}
              </span>
            </span>
            <span class="track" aria-hidden="true">
              <span class={`fill${i === 0 ? ' acc' : ''}`} style={{ width: `${width}%` }} />
            </span>
          </>
        );
        return (
          <li key={c.category_id ?? 'other'}>
            {onOpen ? (
              <button type="button" class="bar-btn" title={t('overview.openCategory', { name })} onClick={() => onOpen(c)}>
                {body}
              </button>
            ) : (
              body
            )}
          </li>
        );
      })}
    </ul>
  );
}
