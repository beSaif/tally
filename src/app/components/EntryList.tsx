import type { Entry } from '@shared/api';
import { formatAmount } from '@shared/money';
import { lang, t } from '../i18n';
import { dayLabel, groupByDay, timeOf } from '../lib/format';

interface Props {
  entries: readonly Entry[];
  today: string;
  currency: string;
  fresh: ReadonlySet<string>;
  onOpen: (entry: Entry) => void;
}

/** Day groups (TODAY / YESTERDAY / SUN 04) with their totals, newest first (design A.1). */
export default function EntryList({ entries, today, currency, fresh, onOpen }: Props) {
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
              <EntryRow key={e.id} entry={e} currency={currency} fresh={fresh.has(e.id)} onOpen={onOpen} />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

function EntryRow({ entry, currency, fresh, onOpen }: { entry: Entry; currency: string; fresh: boolean; onOpen: (e: Entry) => void }) {
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
        <span class="c">{category}</span>
      </span>
      <span class="a">
        {formatAmount(entry.amount_cents)}
        {entry.currency !== currency ? <span class="cur-inline"> {entry.currency}</span> : null}
      </span>
    </li>
  );
}
