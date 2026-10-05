import { daysLeftInMonth } from '@shared/dates';
import { formatBudget, percentOf, splitAmount } from '@shared/money';
import { t } from '../i18n';

/** Home hero (design A.1): month total with faint decimals, budget line and bar, days left. */
export default function Hero({ totalCents, budgetCents, currency, today }: { totalCents: number; budgetCents: number | null; currency: string; today: string }) {
  const { int, frac } = splitAmount(totalCents);
  const budget = budgetCents && budgetCents > 0 ? budgetCents : null;
  const pct = budget ? percentOf(totalCents, budget) : null;
  const left = daysLeftInMonth(today);
  return (
    <section class="hero">
      <h1 class="lbl">{t('home.spent')}</h1>
      <div class="amount-row">
        <span class="big hero-num">
          {int}
          <span class="frac">{frac}</span>
        </span>
        <span class="cur">{currency}</span>
      </div>
      <div class="meta-row">
        <span>{pct !== null && budget ? t('home.ofBudget', { pct, budget: formatBudget(budget) }) : ''}</span>
        <span>{left === 0 ? t('home.lastDay') : t('home.daysLeft', { count: left })}</span>
      </div>
      {pct !== null ? (
        <div class="track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, pct)} aria-label={t('home.ofBudget', { pct, budget: formatBudget(budget ?? 0) })}>
          <div class={`fill${pct >= 100 ? ' acc' : ''}`} style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
      ) : null}
    </section>
  );
}
