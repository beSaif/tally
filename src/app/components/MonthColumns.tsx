import { formatBudget } from '@shared/money';
import { lang } from '../i18n';
import type { MonthPoint } from '../lib/analytics';
import { monthLong, monthShort } from '../lib/format';

/** Month totals as columns (oldest left), heights relative to the largest; `highlight` in the accent. */
export default function MonthColumns({ points, highlight }: { points: readonly MonthPoint[]; highlight: string }) {
  const language = lang.value;
  const top = Math.max(0, ...points.map((p) => p.cents));
  const whole = (cents: number) => formatBudget(Math.round(cents / 100) * 100);
  return (
    <ol class="cols" aria-label={points.map((p) => `${monthLong(`${p.month}-01`, language)} ${whole(p.cents)}`).join(', ')}>
      {points.map((p) => {
        const height = top > 0 ? Math.max(p.cents > 0 ? 3 : 0, Math.round((p.cents / top) * 100)) : 0;
        const on = p.month === highlight;
        return (
          <li key={p.month} class={on ? 'on' : ''} aria-hidden="true">
            <span class="v">{p.cents > 0 ? whole(p.cents) : '–'}</span>
            <span class="col">
              <span class="bar" style={{ height: `${height}%` }} />
            </span>
            <span class="m">{monthShort(`${p.month}-01`, language)}</span>
          </li>
        );
      })}
    </ol>
  );
}
