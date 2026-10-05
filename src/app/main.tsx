import { render } from 'preact';
import './styles/tokens.css';
import './styles/app.css';
import './styles/native.css';
import App from './app';
import { t } from './i18n';
import { setApiHandlers } from './lib/api';
import { initInstall } from './lib/install';
import { installNativeFeel } from './lib/native-feel';
import { bootstrap, signedOut } from './lib/store';
import { registerServiceWorker } from './lib/sw-register';
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

installNativeFeel();
initInstall();

// The Vite dev server has no service worker (it would cache stale modules); the build registers it.
if (import.meta.env.PROD) registerServiceWorker();

const root = document.getElementById('app');
if (root) render(<App />, root);
void bootstrap();
