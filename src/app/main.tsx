import { render } from 'preact';
import './styles/tokens.css';
import './styles/app.css';
import App from './app';
import { t } from './i18n';
import { setApiHandlers } from './lib/api';
import { initInstall } from './lib/install';
import { bootstrap, signedOut } from './lib/store';
import { announceUpdate, registerServiceWorker } from './lib/sw-register';
import { showToast } from './lib/toast';
import { navigate } from './router';

setApiHandlers({
  // The session expired or was revoked (password changed elsewhere): back to the login screen.
  unauthorized: () => {
    signedOut();
    navigate('/login', { replace: true });
  },
  // No queueing in v1: say so and let the person retry.
  offline: () => showToast({ text: t('toast.offline') }),
});
window.addEventListener('offline', () => showToast({ text: t('toast.offline') }));

initInstall();

if (import.meta.env.PROD) {
  registerServiceWorker();
} else {
  // Development only: lets the visual tests preview states that need a real deployment.
  (window as Window & { __tally?: unknown }).__tally = {
    announceUpdate: () => announceUpdate(null),
    toast: (text: string) => showToast({ text }),
  };
}

const root = document.getElementById('app');
if (root) render(<App />, root);
void bootstrap();
