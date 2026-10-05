/** Home (design A.1, spec §3.3): month total, entries by day, composer, capture & entry sheets. */
import { useEffect, useState } from 'preact/hooks';
import type { Entry } from '@shared/api';
import { formatAmount } from '@shared/money';
import { lang, t } from '../i18n';
import { capture, composerFocusRequest } from '../lib/capture';
import { monthLong, monthLongYear, monthShortYear, sumCents, todayLocal } from '../lib/format';
import { offerInstallOnce } from '../lib/install';
import { freshIds, loadCurrentMonth, loadOlderMonth, months, nextOlderMonth, type MonthBlock } from '../lib/ledger';
import { currency, settings } from '../lib/store';
import { onAppVisible } from '../lib/visible';
import { navigate, route, setQuery } from '../router';
import CaptureSheet from '../components/CaptureSheet';
import Composer from '../components/Composer';
import EntryList from '../components/EntryList';
import EntrySheet from '../components/EntrySheet';
import Hero from '../components/Hero';
import { IconGear } from '../components/Icons';
import Wordmark from '../components/Wordmark';

export default function Home() {
  const [open, setOpen] = useState<Entry | null>(null);
  const today = todayLocal();
  const language = lang.value;
  const compose = route.value.query.get('compose');

  useEffect(() => {
    void loadCurrentMonth();
    // Another device may have logged something: refetch when the app comes back to the front.
    return onAppVisible(() => void loadCurrentMonth());
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
      <header class="topline">
        <button type="button" class="wm-btn" aria-label={`Tally · ${t('common.settings')}`} onClick={() => navigate('/settings')}>
          <Wordmark />
        </button>
        <span class="right">
          <button type="button" aria-label={t('home.openOverview')} onClick={() => navigate('/overview')}>
            {monthShortYear(today, language)}
          </button>
          <button type="button" class="ibtn ghost xs" aria-label={t('common.settings')} onClick={() => navigate('/settings')}>
            <IconGear />
          </button>
        </span>
      </header>

      <Hero totalCents={total} budgetCents={settings.value?.budget_cents ?? null} currency={currency.value} today={today} />

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
      {current && current.entries.length > 0 ? (
        <EntryList entries={current.entries} today={today} currency={currency.value} fresh={freshIds.value} onOpen={setOpen} />
      ) : null}

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
