/**
 * Home (design A.1, spec §3.3): month total, what bills need, the month's entries by day, earlier
 * months on request, composer, capture & entry sheets.
 */
import { useEffect, useState } from 'preact/hooks';
import type { BillSuggestion, Entry } from '@shared/api';
import { formatAmount } from '@shared/money';
import { lang, t } from '../i18n';
import { capture, composerFocusRequest } from '../lib/capture';
import { loadSuggestions, syncBills } from '../lib/bills';
import { monthLong, monthLongYear, sumCents, todayLocal } from '../lib/format';
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

export default function Home() {
  const [open, setOpen] = useState<Entry | null>(null);
  const [keeping, setKeeping] = useState<BillSuggestion | null>(null);
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
      {current && current.entries.length > 0 ? <EntryList entries={current.entries} today={today} currency={currency.value} fresh={freshIds.value} onOpen={setOpen} /> : null}

      {older.map((b) => (
        <OlderMonth key={b.key} block={b} today={today} onOpen={setOpen} />
      ))}

      {nextMonth ? (
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
