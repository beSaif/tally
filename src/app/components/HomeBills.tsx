/**
 * The bills part of Home: what is due now (with Paid it / Not yet), the next bill, and a habit
 * that looks like a bill.
 */
import { useState } from 'preact/hooks';
import type { Bill, BillSuggestion } from '@shared/api';
import { addDays, monthRange, toLocalMinute } from '@shared/dates';
import { formatAmount } from '@shared/money';
import { lang, t } from '../i18n';
import { bills, dismissSuggestion, dueNow, nextLabel, payBill, snooze, suggestions } from '../lib/bills';
import { dayShortMonth, todayLocal } from '../lib/format';
import { currency } from '../lib/store';
import { showToast } from '../lib/toast';
import { navigate } from '../router';
import { cadenceName, RepeatMark } from './BillBits';
import { IconChevronRight } from './Icons';

function Amount({ cents, cur }: { cents: number; cur: string }) {
  return (
    <span class="mono bill-amt">
      {formatAmount(cents)}
      {cur !== currency.value ? <span class="cur-inline"> {cur}</span> : null}
    </span>
  );
}

function DueCard({ bill, today }: { bill: Bill; today: string }) {
  const [busy, setBusy] = useState(false);
  const paid = async () => {
    setBusy(true);
    try {
      await payBill(bill, toLocalMinute(new Date()));
    } catch {
      setBusy(false);
      showToast({ text: t('bills.failed') });
    }
  };
  return (
    <section class="bill-card due" aria-label={bill.description}>
      <div class="lbl acc state">
        <span class="dot" />
        {bill.next_due === today ? t('bills.dueToday') : t('bills.overdue', { date: nextLabel(bill.next_due) })}
      </div>
      <div class="bill-card-main">
        <span class="bill-name">{bill.description}</span>
        <Amount cents={bill.amount_cents} cur={bill.currency} />
      </div>
      <div class="bill-sub">
        {bill.category_name ?? t('common.other')} · {cadenceName(bill.cadence)}
      </div>
      <div class="btns even tight">
        <button type="button" class="btn" disabled={busy} onClick={() => snooze(bill)}>
          {t('bills.notYet')}
        </button>
        <button type="button" class="btn primary" disabled={busy} onClick={() => void paid()}>
          {busy ? '…' : t('bills.paidIt')}
        </button>
      </div>
    </section>
  );
}

/** How far ahead Home looks for the next bill, past the end of this month. */
const NEXT_BILL_DAYS = 7;

/**
 * "Swisscom mobile · Wed 14 … 45.00 ›": the first bill still to come, and how many follow this
 * month. Only while it is close (this month or the next week); the calendar has the rest.
 */
function NextBill({ today }: { today: string }) {
  const upcoming = bills.value.filter((b) => b.next_due > today);
  const next = upcoming[0];
  const monthEnd = monthRange(today).to;
  const soon = addDays(today, NEXT_BILL_DAYS);
  if (!next || next.next_due > (soon > monthEnd ? soon : monthEnd)) return null;
  const more = upcoming.slice(1).filter((b) => b.next_due <= monthEnd).length;
  const when = next.next_due === addDays(today, 1) ? t('bills.nextTomorrow') : nextLabel(next.next_due);
  const caption = more > 0 ? t('bills.nextMore', { count: more }) : next.mode === 'auto' ? t('bills.logsItself') : t('bills.next');
  return (
    <button type="button" class="bill-strip" onClick={() => navigate(`/bills?d=${next.next_due}`)}>
      <RepeatMark />
      <span class="bill-strip-text">
        <span class="bill-name">
          {next.description} · {when}
        </span>
        <span class="bill-sub">{caption}</span>
      </span>
      <Amount cents={next.amount_cents} cur={next.currency} />
      <span class="chev" aria-hidden="true">
        <IconChevronRight />
      </span>
    </button>
  );
}

function Suggestion({ s, onKeep }: { s: BillSuggestion; onKeep: (s: BillSuggestion) => void }) {
  const days = s.seen.map((d) => dayShortMonth(d, lang.value)).join(' · ');
  return (
    <section class="bill-card" aria-label={t('bills.looksLike')}>
      <div class="bill-card-main">
        <span class="lbl ink state">
          <span class="dot" />
          {t('bills.looksLike')}
        </span>
        <Amount cents={s.amount_cents} cur={s.currency} />
      </div>
      <div class="bill-name big-name">{s.description}</div>
      <div class="bill-sub">
        {t('bills.seenSame', { days })} · {cadenceName(s.cadence)}
      </div>
      <div class="btns tight">
        <button type="button" class="btn" onClick={() => void dismissSuggestion(s)}>
          {t('bills.notABill')}
        </button>
        <button type="button" class="btn primary" onClick={() => onKeep(s)}>
          {t('bills.keep')}
        </button>
      </div>
    </section>
  );
}

export default function HomeBills({ onKeep }: { onKeep: (s: BillSuggestion) => void }) {
  const today = todayLocal();
  const due = dueNow.value;
  const first = suggestions.value[0];
  return (
    <div class="home-bills">
      {due.map((b) => (
        <DueCard key={b.id} bill={b} today={today} />
      ))}
      <NextBill today={today} />
      {first ? <Suggestion s={first} onKeep={onKeep} /> : null}
    </div>
  );
}
