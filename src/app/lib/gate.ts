/** The auth gate (spec §3): which screen a path shows, and where to redirect. Pure for testing. */
export type Screen = 'login' | 'privacy' | 'setup' | 'home' | 'overview' | 'report' | 'settings';

export interface GateInput {
  path: string;
  authed: boolean;
  hasKey: boolean;
  setupComplete: boolean;
}

export interface GateResult {
  screen: Screen;
  /** Set when the URL should be replaced to match the screen. */
  redirect?: string;
}

const APP_SCREENS: Record<string, Screen> = { '/': 'home', '/overview': 'overview', '/report': 'report', '/settings': 'settings' };

export function gate({ path, authed, hasKey, setupComplete }: GateInput): GateResult {
  const p = path.length > 1 ? path.replace(/\/+$/, '') : path;
  // The privacy policy is public: Google's consent screen links to it.
  if (p === '/privacy') return { screen: 'privacy' };
  // One sign-in screen; the old /signup and anything else unknown lead there.
  if (!authed) return p === '/login' ? { screen: 'login' } : { screen: 'login', redirect: '/login' };
  if (!hasKey || !setupComplete) {
    return p === '/setup' ? { screen: 'setup' } : { screen: 'setup', redirect: '/setup' };
  }
  const screen = APP_SCREENS[p];
  return screen ? { screen } : { screen: 'home', redirect: '/' };
}
