import { t } from '../i18n';
import { back, navigate } from '../router';
import { IconGear } from './Icons';
import Wordmark from './Wordmark';

export type View = 'ledger' | 'analytics';

/**
 * Top line of Home and Analytics: wordmark (→ settings), the Ledger | Analytics switch and the gear.
 * Analytics is pushed on top of the ledger, so going back to the ledger is a history step and the
 * phone's back button does the same.
 */
export default function AppTopline({ view }: { view: View }) {
  return (
    <header class="topline">
      <button type="button" class="wm-btn" aria-label={`Tally · ${t('common.settings')}`} onClick={() => navigate('/settings')}>
        <Wordmark />
      </button>
      <span class="right">
        <span class="views" role="tablist" aria-label={t('nav.views')}>
          <ViewTab on={view === 'ledger'} label={t('nav.ledger')} go={() => back('/')} />
          <ViewTab on={view === 'analytics'} label={t('nav.analytics')} go={() => navigate('/overview')} />
        </span>
        <button type="button" class="ibtn ghost xs" aria-label={t('common.settings')} onClick={() => navigate('/settings')}>
          <IconGear />
        </button>
      </span>
    </header>
  );
}

function ViewTab({ on, label, go }: { on: boolean; label: string; go: () => void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={on}
      class={on ? 'on' : ''}
      onClick={() => {
        if (!on) go();
      }}
    >
      {label}
    </button>
  );
}
