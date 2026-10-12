/**
 * Bills (/bills): a month calendar of what comes due, paid and still to pay. Tapping a day scopes
 * the composer to it, so saying "piano lessons 140 monthly" puts a bill on that day. `?id=` opens one
 * bill: its next dates, what it paid, and how it is logged.
 */
import { useEffect, useState } from 'preact/hooks';
import type { Bill, BillDetail, BillSuggestion } from '@shared/api';
import { monthlyCents, nextAfter, occurrencesBetween } from '@shared/bills';
import { addDays, addMonths, daysBetween, isValidDay, monthRange, toLocalMinute, weekdayOf } from '@shared/dates';
import { formatAmount } from '@shared/money';
import { lang, localeOf, t } from '../i18n';
import { api } from '../lib/api';
import { bills, billsLoaded, deleteBill, dismissSuggestion, loadSuggestions, nextLabel, payBill, skipBill, suggestions, syncBills, updateBill } from '../lib/bills';
import { billDay, capture } from '../lib/capture';
import { cadenceLabel, dayOf, dayShortMonth, monthLongYear, timeOf, todayLocal, weekdayDayMonth } from '../lib/format';
import { currency } from '../lib/store';
import { showToast } from '../lib/toast';
import { onAppVisible } from '../lib/visible';
import { back, navigate, route, setQuery } from '../router';
import { cadenceName, ModeSwitch, RepeatMark } from '../components/BillBits';
import BillSheet, { type BillSheetFor } from '../components/BillSheet';
import CaptureSheet from '../components/CaptureSheet';
import Composer from '../components/Composer';
import { IconChevronLeft, IconChevronRight } from '../components/Icons';
import Sheet from '../components/Sheet';

export default function Bills() {
  const id = route.value.query.get('id');
  return id ? <BillPage key={id} id={id} /> : <BillsCalendar />;
}

// ---------------------------------------------------------------- calendar

interface Due {
  bill: Bill;
  day: string;
  paid: boolean;
}

/** Every occurrence in a month; one is paid (or skipped) once the bill's next_due is past it. */
function dueInMonth(list: readonly Bill[], from: string, to: string): Map<string, Due[]> {
  const byDay = new Map<string, Due[]>();
  for (const bill of list) {
    for (const day of occurrencesBetween(bill.anchor, bill.cadence, from, to, 31)) {
      const due: Due = { bill, day, paid: day < bill.next_due };
      byDay.set(day, [...(byDay.get(day) ?? []), due]);
    }
  }
  return byDay;
}

const sum = (list: readonly Due[]): number => list.reduce((n, d) => n + d.bill.amount_cents, 0);

/** Narrow weekday letters, Monday first ("M T W …" / "L M M …"). */
function weekdayLetters(): string[] {
  const fmt = new Intl.DateTimeFormat(localeOf(lang.value), { weekday: 'narrow' });
  // 2024-01-01 was a Monday.
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2024, 0, 1 + i, 12)));
}

function BillsCalendar() {
  const today = todayLocal();
  const q = route.value.query;
  const picked = q.get('d');
  const day = picked && isValidDay(picked) ? picked : today;
  const month = monthRange(day);
  const [found, setFound] = useState(false);
  const [keeping, setKeeping] = useState<BillSuggestion | null>(null);

  useEffect(() => {
    void syncBills();
    void loadSuggestions();
    return onAppVisible(() => void syncBills());
  }, []);

  // What is said in the composer here is a bill on the picked day.
  useEffect(() => {
    billDay.value = day;
  }, [day]);
  useEffect(() => () => void (billDay.value = null), []);

  const byDay = dueInMonth(bills.value, month.from, month.to);
  const all = [...byDay.values()].flat();
  const paid = sum(all.filter((d) => d.paid));
  const toPay = sum(all.filter((d) => !d.paid));
  const picks = byDay.get(day) ?? [];
  const language = lang.value;

  const pick = (d: string) => setQuery({ d });
  const shift = (n: number) => setQuery({ d: monthRange(addMonths(month.from, n)).from });

  // Monday-first weeks covering the month.
  const start = addDays(month.from, -((weekdayOf(month.from) + 6) % 7));
  const cells = Math.ceil(daysBetween(start, month.to) / 7) * 7;
  const days = Array.from({ length: cells }, (_, i) => addDays(start, i));

  return (
    <main class={`screen screen--list bills${capture.value.kind !== 'idle' ? ' capturing' : ''}`}>
      <header class="topline">
        <button type="button" onClick={() => back('/')}>
          {t('common.back')}
        </button>
        <span class="right">
          <button type="button" class="ibtn ghost xs" aria-label={t('bills.prevMonth')} onClick={() => shift(-1)}>
            <IconChevronLeft />
          </button>
          <h1 class="topline-title month-title">{monthLongYear(month.from, language)}</h1>
          <button type="button" class="ibtn ghost xs" aria-label={t('bills.nextMonth')} onClick={() => shift(1)}>
            <IconChevronRight />
          </button>
        </span>
      </header>

      <div class="bill-sums">
        <div>
          <div class="lbl">{t('bills.paidSum')}</div>
          <div class="mono sum mute">{formatAmount(paid)}</div>
        </div>
        <div>
          <div class="lbl">{t('bills.toPay')}</div>
          <div class="mono sum">{formatAmount(toPay)}</div>
        </div>
        {suggestions.value.length > 0 ? (
          <button type="button" class="pill found-chip" onClick={() => setFound(true)}>
            <span class="dot" />
            {t('bills.found', { count: suggestions.value.length })}
          </button>
        ) : null}
      </div>

      <div class="cal-head" aria-hidden="true">
        {weekdayLetters().map((l, i) => (
          <span key={i}>{l}</span>
        ))}
      </div>
      <div class="cal" role="group" aria-label={monthLongYear(month.from, language)}>
        {days.map((d) => {
          if (d < month.from || d > month.to) return <span key={d} class="cal-day out" aria-hidden="true" />;
          const list = byDay.get(d) ?? [];
          const cents = sum(list);
          const allPaid = list.length > 0 && list.every((x) => x.paid);
          const label = list.length > 0 ? t('bills.day', { date: weekdayDayMonth(d, language), amount: formatAmount(cents) }) : t('bills.dayEmpty', { date: weekdayDayMonth(d, language) });
          return (
            <button
              key={d}
              type="button"
              class={`cal-day${d === day ? ' sel' : ''}${d === today ? ' today' : ''}${allPaid ? ' paid' : ''}`}
              aria-pressed={d === day}
              aria-label={label}
              onClick={() => pick(d)}
            >
              <b>{Number(d.slice(8))}</b>
              {list.length > 0 ? <i>{formatAmount(cents, { decimals: false })}</i> : null}
            </button>
          );
        })}
      </div>

      <h2 class="daygrp">
        <span>{weekdayDayMonth(day, language)}</span>
        <span>{picks.length > 0 ? formatAmount(sum(picks)) : ''}</span>
      </h2>
      {picks.length > 0 ? (
        <ul class="entries bill-rows">
          {picks.map((p) => (
            <BillRow key={p.bill.id} due={p} />
          ))}
        </ul>
      ) : (
        <p class="month-note">
          {t('bills.nothingDue')} · {t('bills.addHint')}
        </p>
      )}
      {billsLoaded.value && bills.value.length === 0 ? <p class="month-note">{t('bills.empty')}</p> : null}

      <Composer placeholder={t('composer.billPlaceholder', { date: dayShortMonth(day, language) })} />
      <CaptureSheet />
      {found ? (
        <FoundSheet
          onClose={() => setFound(false)}
          onKeep={(s) => {
            setFound(false);
            setKeeping(s);
          }}
        />
      ) : null}
      {keeping ? <BillSheet key={keeping.key} target={{ kind: 'keep', suggestion: keeping }} onClose={() => setKeeping(null)} /> : null}
    </main>
  );
}

function BillRow({ due }: { due: Due }) {
  const { bill, paid } = due;
  const open = () => navigate(`/bills?id=${encodeURIComponent(bill.id)}`);
  return (
    <li
      class={`row-btn${paid ? ' done' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={t('bills.open', { name: bill.description })}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
    >
      <span class="t">
        <RepeatMark />
      </span>
      <span>
        <span class="n">{bill.description}</span>
        <span class="c">
          {paid ? `${t('bills.paid')} · ` : ''}
          {bill.category_name ?? t('common.other')} · {cadenceName(bill.cadence)} · {t(bill.mode === 'auto' ? 'bills.mode.auto' : 'bills.mode.ask')}
        </span>
      </span>
      <span class="a">
        {formatAmount(bill.amount_cents)}
        {bill.currency !== currency.value ? <span class="cur-inline"> {bill.currency}</span> : null}
      </span>
    </li>
  );
}

function FoundSheet({ onClose, onKeep }: { onClose: () => void; onKeep: (s: BillSuggestion) => void }) {
  const list = suggestions.value;
  const language = lang.value;
  return (
    <Sheet label={t('bills.foundTitle')} onClose={onClose}>
      <div class="sheet-head">
        <span class="lbl ink state">
          <span class="dot" />
          {t('bills.foundTitle')}
        </span>
      </div>
      <p class="note found-lead">{t('bills.foundLead')}</p>
      {list.length === 0 ? <p class="month-note">{t('bills.noneFound')}</p> : null}
      <ul class="found">
        {list.map((s) => (
          <li key={s.key}>
            <div class="found-top">
              <span class="n">{s.description}</span>
              <span class="mono">{formatAmount(s.amount_cents)}</span>
            </div>
            <div class="c">
              {cadenceName(s.cadence)} · {s.seen.map((d) => dayShortMonth(d, language)).join(' · ')}
            </div>
            <div class="btns even tight">
              <button type="button" class="btn" onClick={() => void dismissSuggestion(s)}>
                {t('bills.notABill')}
              </button>
              <button type="button" class="btn primary" onClick={() => onKeep(s)}>
                {t('common.keep')}
              </button>
            </div>
          </li>
        ))}
      </ul>
      <div class="btns single">
        <button type="button" class="btn" onClick={onClose}>
          {t('common.close')}
        </button>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------- one bill

type Load = { status: 'loading' } | { status: 'ready'; detail: BillDetail } | { status: 'gone' } | { status: 'error' };

function BillPage({ id }: { id: string }) {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [editing, setEditing] = useState<BillSheetFor | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const today = todayLocal();
  const language = lang.value;

  const fetchDetail = async () => {
    try {
      setLoad({ status: 'ready', detail: await api.bill(id) });
    } catch (err) {
      setLoad({ status: (err as { code?: string }).code === 'not_found' ? 'gone' : 'error' });
    }
  };
  useEffect(() => {
    void fetchDetail();
  }, [id]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await fetchDetail();
    } catch {
      showToast({ text: t('bills.failed') });
      await fetchDetail();
    }
    setBusy(false);
  };

  const header = (
    <header class="topline">
      <button type="button" onClick={() => back('/bills')}>
        {t('common.back')}
      </button>
      <h1 class="topline-title">{t('bills.billTitle')}</h1>
      {load.status === 'ready' ? (
        <button type="button" class="topline-action" onClick={() => setEditing({ kind: 'edit', bill: load.detail.bill })}>
          {t('common.edit')}
        </button>
      ) : (
        <span />
      )}
    </header>
  );

  if (load.status !== 'ready') {
    return (
      <main class="screen bill-page">
        {header}
        <p class="month-note">
          {load.status === 'loading' ? t('common.loading') : load.status === 'gone' ? t('bills.notFound') : t('bills.loadFailed')}
        </p>
      </main>
    );
  }

  const { bill, entries } = load.detail;
  const next = [bill.next_due];
  while (next.length < 3) next.push(nextAfter(bill.anchor, bill.cadence, next[next.length - 1] as string));
  const until = daysBetween(today, bill.next_due) - 1;
  const when =
    bill.next_due < today ? t('bills.overdue', { date: nextLabel(bill.next_due) }) : until === 0 ? t('bills.nextToday') : t('bills.inDays', { count: until });

  return (
    <main class="screen bill-page">
      {header}
      <div class="lbl bill-kicker">
        <RepeatMark />
        {bill.category_name ?? t('common.other')} · {cadenceName(bill.cadence)}
      </div>
      <h2 class="bill-title">{bill.description}</h2>
      <div class="amount-row">
        <span class="big bill-num">{formatAmount(bill.amount_cents)}</span>
        <span class="cur">
          {bill.currency} · {cadenceLabel(bill.cadence, bill.anchor, language)}
        </span>
      </div>
      {bill.cadence !== 'monthly' ? <p class="note">{t('bills.perMonth', { amount: formatAmount(monthlyCents(bill.amount_cents, bill.cadence)) })}</p> : null}

      <h3 class="daygrp">
        <span>{t('bills.next3')}</span>
        <span>{when}</span>
      </h3>
      <ol class="next-dates">
        {next.map((d, i) => (
          <li key={d} class={i === 0 ? 'on' : ''}>
            <span class="lbl">{weekdayDayMonth(d, language).split(' ')[0]}</span>
            <span class="mono">{dayShortMonth(d, language)}</span>
          </li>
        ))}
      </ol>

      <ModeSwitch value={bill.mode} onChange={(mode) => void act(() => updateBill(bill.id, { mode }))} />

      <h3 class="daygrp">
        <span>{t('bills.history')}</span>
        <span>{t('bills.since', { date: dayShortMonth(bill.anchor, language) })}</span>
      </h3>
      {entries.length > 0 ? (
        <ul class="entries">
          {entries.map((e) => (
            <li key={e.id}>
              <span class="t">{timeOf(e.occurred_at)}</span>
              <span>
                <span class="n">{weekdayDayMonth(dayOf(e.occurred_at), language)}</span>
              </span>
              <span class="a">{formatAmount(e.amount_cents)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p class="month-note">{t('bills.noHistory')}</p>
      )}

      {confirmStop ? (
        <div class="confirm inline">
          <p class="confirm-q">{t('bills.confirmStop', { name: bill.description })}</p>
          <div class="btns even">
            <button type="button" class="btn" disabled={busy} onClick={() => setConfirmStop(false)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              class="btn danger-fill"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await deleteBill(bill.id);
                  showToast({ text: t('bills.stopped') });
                  back('/bills');
                } catch {
                  setBusy(false);
                  showToast({ text: t('bills.failed') });
                }
              }}
            >
              {t('bills.stop')}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div class="btns even">
            <button type="button" class="btn" disabled={busy} onClick={() => void act(() => skipBill(bill))}>
              {t('bills.skip')}
            </button>
            <button type="button" class="btn primary" disabled={busy} onClick={() => void act(() => payBill(bill, toLocalMinute(new Date())))}>
              {busy ? '…' : t('bills.payNow')}
            </button>
          </div>
          <button type="button" class="link danger-link" onClick={() => setConfirmStop(true)}>
            {t('bills.stop')}
          </button>
        </>
      )}

      {editing ? <BillSheet target={editing} onClose={() => setEditing(null)} onSaved={() => void fetchDetail()} /> : null}
    </main>
  );
}

