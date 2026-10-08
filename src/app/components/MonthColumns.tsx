import { formatBudget } from '@shared/money';
import { lang, t } from '../i18n';
import type { MonthPoint } from '../lib/analytics';
import { monthLong, monthShort } from '../lib/format';

/** Whole units, as the columns are labelled: 148.80 → "149". */
export const wholeAmount = (cents: number): string => formatBudget(Math.round(cents / 100) * 100);

interface Props {
  points: readonly MonthPoint[];
  /** The month in the accent. */
  highlight: string;
  /** Drawn as a dashed line across the columns. */
  averageCents?: number | null;
}

/** Month totals as columns (oldest left), heights relative to the largest; `highlight` in the accent. */
export default function MonthColumns({ points, highlight, averageCents }: Props) {
  const language = lang.value;
  const top = Math.max(0, ...points.map((p) => p.cents));
  const avg = averageCents != null && averageCents > 0 && top > 0 ? Math.round((averageCents / top) * 100) : null;
  const label = points.map((p) => `${monthLong(`${p.month}-01`, language)} ${wholeAmount(p.cents)}`).join(', ');
  return (
    <ol class="cols" aria-label={averageCents != null ? `${label}. ${t('category.avg', { amount: wholeAmount(averageCents) })}` : label}>
      {points.map((p) => {
        const height = top > 0 ? Math.max(p.cents > 0 ? 3 : 0, Math.round((p.cents / top) * 100)) : 0;
        const on = p.month === highlight;
        return (
          <li key={p.month} class={on ? 'on' : ''} aria-hidden="true">
            <span class="v">{p.cents > 0 ? wholeAmount(p.cents) : '–'}</span>
            <span class="col">
              <span class="bar" style={{ height: `${height}%` }} />
              {avg !== null ? <span class="avg" style={{ bottom: `${avg}%` }} /> : null}
            </span>
            <span class="m">{monthShort(`${p.month}-01`, language)}</span>
          </li>
        );
      })}
    </ol>
  );
}
