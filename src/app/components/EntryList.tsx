import type { Entry } from '@shared/api';
import { formatAmount } from '@shared/money';
import { lang, t } from '../i18n';
import { dayLabel, groupByDay, timeOf } from '../lib/format';
import { RepeatMark } from './BillBits';

interface Props {
  entries: readonly Entry[];
  today: string;
  currency: string;
  fresh: ReadonlySet<string>;
  onOpen: (entry: Entry) => void;
  /** Off where every entry has the same category (Analytics drill-down). */
  showCategory?: boolean;
}

/** Day groups (TODAY / YESTERDAY / SUN 04) with their totals, newest first (design A.1). */
export default function EntryList({ entries, today, currency, fresh, onOpen, showCategory = true }: Props) {
  const language = lang.value;
  return (
    <>
      {groupByDay(entries).map((g) => (
        <section key={g.day} class="day">
          <h3 class="daygrp">
            <span>{dayLabel(g.day, today, language)}</span>
            <span>{formatAmount(g.totalCents)}</span>
          </h3>
          <ul class="entries">
            {g.entries.map((e) => (
              <EntryRow key={e.id} entry={e} currency={currency} fresh={fresh.has(e.id)} onOpen={onOpen} showCategory={showCategory} />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

function EntryRow({ entry, currency, fresh, onOpen, showCategory }: { entry: Entry; currency: string; fresh: boolean; onOpen: (e: Entry) => void; showCategory: boolean }) {
  const category = entry.category_name ?? t('common.other');
  return (
    <li
      class={`row-btn${fresh ? ' fresh' : ''}`}
      role="button"
      tabIndex={0}
      data-entry={entry.id}
      onClick={() => onOpen(entry)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(entry);
        }
      }}
    >
      <span class="t">{timeOf(entry.occurred_at)}</span>
      <span>
        <span class="n">{entry.description}</span>
        {showCategory || entry.bill_id ? (
          <span class="c">
            {entry.bill_id ? <RepeatMark /> : null}
            {showCategory ? category : t('bills.fromBill')}
          </span>
        ) : null}
      </span>
      <EntryAmount entry={entry} currency={currency} />
    </li>
  );
}

/**
 * An entry's amount as paid, with its currency when that is not the person's own, and then what
 * it counts for in theirs ("≈ 15.84") once the day's rate is known.
 */
export function EntryAmount({ entry, currency }: { entry: Entry; currency: string }) {
  const foreign = entry.currency !== currency;
  return (
    <span class="a">
      {formatAmount(entry.amount_cents)}
      {foreign ? <span class="cur-inline"> {entry.currency}</span> : null}
      {foreign && entry.home_cents !== null ? <span class="home-amt">≈ {formatAmount(entry.home_cents)}</span> : null}
    </span>
  );
}
