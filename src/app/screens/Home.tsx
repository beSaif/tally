/**
 * Home (design A.1, spec §3.3): month total, what bills need, the last two days of entries with the
 * rest of the month faded below them, composer, capture & entry sheets.
 */
import { useEffect, useState } from 'preact/hooks';
import type { BillSuggestion, Entry } from '@shared/api';
import { formatAmount } from '@shared/money';
import { lang, t } from '../i18n';
import { capture, composerFocusRequest } from '../lib/capture';
import { loadSuggestions, syncBills } from '../lib/bills';
import { dayOf, groupByDay, monthLong, monthLongYear, sumCents, todayLocal } from '../lib/format';
import { offerInstallOnce } from '../lib/install';
import { freshIds, loadCurrentMonth, loadOlderMonth, months, nextOlderMonth, type MonthBlock } from '../lib/ledger';
import { currency, settings } from '../lib/store';
import { onAppVisible } from '../lib/visible';
import { route, setQuery } from '../router';
import AppTopline from '../components/AppTopline';
import BillSheet from '../components/BillSheet';
import CaptureSheet from '../components/CaptureSheet';
import Composer from '../components/Composer';
import EntryList from '../components/EntryList';
import EntrySheet from '../components/EntrySheet';
import Hero from '../components/Hero';
import HomeBills from '../components/HomeBills';
import { IconChevronDown } from '../components/Icons';

/** Days shown in full at the top; the rest of the month waits, faded, below them. */
const RECENT_DAYS = 2;

export default function Home() {
  const [open, setOpen] = useState<Entry | null>(null);
  const [keeping, setKeeping] = useState<BillSuggestion | null>(null);
  const [earlierOpen, setEarlierOpen] = useState(false);
  const today = todayLocal();
  const language = lang.value;
  const compose = route.value.query.get('compose');

  useEffect(() => {
    void loadCurrentMonth();
    void syncBills();
    void loadSuggestions();
    // Another device may have logged something, or a bill came due: refetch when the app comes back.
    return onAppVisible(() => {
      void loadCurrentMonth();
      void syncBills();
    });
  }, []);

  useEffect(() => {
    if (compose !== '1') return;
    composerFocusRequest.value++;
    setQuery({ compose: null });
  }, [compose]);

  // A good moment to suggest installing: right after the first thing was logged here.
  useEffect(() => {
    if (freshIds.value.size > 0) offerInstallOnce();
  }, [freshIds.value]);

  const blocks = months.value;
  const current = blocks[0];
  const older = blocks.slice(1);
  const total = current ? sumCents(current.entries) : 0;
  const nextMonth = nextOlderMonth.value;
  const isEmpty = current?.status === 'ready' && current.entries.length === 0;
  const recentDays = new Set(groupByDay(current?.entries ?? []).slice(0, RECENT_DAYS).map((g) => g.day));
  const recent = (current?.entries ?? []).filter((e) => recentDays.has(dayOf(e.occurred_at)));
  const earlier = (current?.entries ?? []).filter((e) => !recentDays.has(dayOf(e.occurred_at)));
  const hasEarlier = earlier.length > 0;
  // Older months live under "earlier" too: nothing below the two days shows until it is opened.
  const showRest = earlierOpen || !hasEarlier;

  return (
    <main class={`screen screen--list home${capture.value.kind !== 'idle' ? ' capturing' : ''}`}>
      <AppTopline view="ledger" />

      <Hero totalCents={total} budgetCents={settings.value?.budget_cents ?? null} currency={currency.value} today={today} />

      <HomeBills onKeep={setKeeping} />

      {current?.status === 'error' && current.entries.length === 0 ? (
        <div class="empty">
          <p>
            {t('home.loadFailed')}{' '}
            <button type="button" class="link" onClick={() => void loadCurrentMonth()}>
              {t('common.tryAgain')}
            </button>
          </p>
        </div>
      ) : null}
      {isEmpty ? (
        <div class="empty">
          <p>{t('home.empty')}</p>
        </div>
      ) : null}
      {recent.length > 0 ? <EntryList entries={recent} today={today} currency={currency.value} fresh={freshIds.value} onOpen={setOpen} /> : null}

      {hasEarlier ? (
        <section class={`earlier${earlierOpen ? ' open' : ''}`}>
          <div class="earlier-body" aria-hidden={!earlierOpen} {...(earlierOpen ? {} : { inert: true })}>
            <EntryList entries={earlier} today={today} currency={currency.value} fresh={freshIds.value} onOpen={setOpen} />
          </div>
          {earlierOpen ? null : (
            <button type="button" class="earlier-toggle" aria-expanded={false} onClick={() => setEarlierOpen(true)}>
              <span>
                {t('home.earlier')} · {formatAmount(sumCents(earlier))}
              </span>
              <IconChevronDown />
            </button>
          )}
        </section>
      ) : null}

      {showRest
        ? older.map((b) => (
            <OlderMonth key={b.key} block={b} today={today} onOpen={setOpen} />
          ))
        : null}

      {showRest && nextMonth ? (
        <button type="button" class="more" onClick={() => void loadOlderMonth()}>
          {t('home.showMonth', { month: monthLong(nextMonth, language) })}
        </button>
      ) : null}

      <Composer />
      <CaptureSheet />
      {open ? <EntrySheet key={open.id} entry={open} onClose={() => setOpen(null)} /> : null}
      {keeping ? <BillSheet key={keeping.key} target={{ kind: 'keep', suggestion: keeping }} onClose={() => setKeeping(null)} /> : null}
    </main>
  );
}

function OlderMonth({ block, today, onOpen }: { block: MonthBlock; today: string; onOpen: (e: Entry) => void }) {
  const language = lang.value;
  return (
    <section class="month">
      <h2 class="daygrp month-head">
        <span>
          {monthLongYear(block.from, language)}
          {block.status === 'ready' ? ` · ${formatAmount(sumCents(block.entries))}` : ''}
        </span>
      </h2>
      {block.status === 'loading' ? <p class="month-note">{t('common.loading')}</p> : null}
      {block.status === 'error' ? <p class="month-note">{t('home.loadFailed')}</p> : null}
      {block.status === 'ready' && block.entries.length === 0 ? <p class="month-note">{t('home.monthEmpty')}</p> : null}
      {block.entries.length > 0 ? <EntryList entries={block.entries} today={today} currency={currency.value} fresh={freshIds.value} onOpen={onOpen} /> : null}
    </section>
  );
}
