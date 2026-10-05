/** Root: auth gate (spec §3), screen routing, global toasts and background refreshes. */
import { useEffect, useLayoutEffect } from 'preact/hooks';
import { lang } from './i18n';
import { gate, type Screen } from './lib/gate';
import { resyncPush, shareLanguageWithWorker } from './lib/push';
import { geminiKey, refreshBootstrap, sessionState, settings } from './lib/store';
import { navigate, route } from './router';
import ToastHost from './components/ToastHost';
import AuthScreen from './screens/Auth';
import Home from './screens/Home';
import Overview from './screens/Overview';
import Settings from './screens/Settings';
import Setup from './screens/Setup';

const REFRESH_GAP_MS = 5000;

export default function App() {
  const state = sessionState.value;
  const language = lang.value;

  // Settings may change on another device: refresh them when the app comes back to the front.
  useEffect(() => {
    let last = Date.now();
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || Date.now() - last < REFRESH_GAP_MS) return;
      last = Date.now();
      void refreshBootstrap();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  // Keep this device's push subscription in the right language / time zone (spec §8.1).
  useEffect(() => {
    if (state !== 'authed') return;
    void shareLanguageWithWorker(language);
    void resyncPush(language);
  }, [state, language]);

  if (state === 'loading') return <main class="screen splash" aria-busy="true" />;
  return <Routed />;
}

function Routed() {
  const r = route.value;
  const authed = sessionState.value === 'authed';
  const result = gate({
    path: r.path,
    authed,
    hasKey: Boolean(geminiKey.value),
    setupComplete: Boolean(settings.value?.setup_complete),
  });

  useLayoutEffect(() => {
    if (result.redirect && location.pathname !== result.redirect) navigate(result.redirect, { replace: true });
  }, [result.redirect, r.path]);

  return (
    <>
      <ScreenView screen={result.screen} />
      <ToastHost withComposer={result.screen === 'home'} />
    </>
  );
}

function ScreenView({ screen }: { screen: Screen }) {
  switch (screen) {
    case 'login':
      return <AuthScreen key="login" mode="login" />;
    case 'signup':
      return <AuthScreen key="signup" mode="signup" />;
    case 'setup':
      return <Setup />;
    case 'overview':
      return <Overview />;
    case 'settings':
      return <Settings />;
    default:
      return <Home />;
  }
}
