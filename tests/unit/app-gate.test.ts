import { describe, expect, it } from 'vitest';
import { gate } from '@app/lib/gate';

const stranger = { authed: false, hasKey: false, setupComplete: false };
const ready = { authed: true, hasKey: true, setupComplete: true };

describe('gate', () => {
  it('sends strangers to the login screen, wherever they were going', () => {
    expect(gate({ path: '/', ...stranger })).toEqual({ screen: 'login', redirect: '/login' });
    expect(gate({ path: '/login', ...stranger })).toEqual({ screen: 'login' });
    expect(gate({ path: '/login/', ...stranger })).toEqual({ screen: 'login' });
    expect(gate({ path: '/signup', ...stranger })).toEqual({ screen: 'login', redirect: '/login' });
    expect(gate({ path: '/settings', ...stranger })).toEqual({ screen: 'login', redirect: '/login' });
  });

  it('shows the privacy policy to anyone', () => {
    expect(gate({ path: '/privacy', ...stranger })).toEqual({ screen: 'privacy' });
    expect(gate({ path: '/privacy/', authed: true, hasKey: false, setupComplete: false })).toEqual({ screen: 'privacy' });
    expect(gate({ path: '/privacy', ...ready })).toEqual({ screen: 'privacy' });
  });

  it('insists on setup until this device has a key and setup is complete', () => {
    expect(gate({ path: '/', authed: true, hasKey: false, setupComplete: true })).toEqual({ screen: 'setup', redirect: '/setup' });
    expect(gate({ path: '/overview', authed: true, hasKey: true, setupComplete: false })).toEqual({ screen: 'setup', redirect: '/setup' });
    expect(gate({ path: '/setup', authed: true, hasKey: false, setupComplete: false })).toEqual({ screen: 'setup' });
    expect(gate({ path: '/login', authed: true, hasKey: false, setupComplete: false })).toEqual({ screen: 'setup', redirect: '/setup' });
  });

  it('routes a ready account, and sends unknown paths home', () => {
    expect(gate({ path: '/', ...ready })).toEqual({ screen: 'home' });
    expect(gate({ path: '/overview', ...ready })).toEqual({ screen: 'overview' });
    expect(gate({ path: '/report', ...ready })).toEqual({ screen: 'report' });
    expect(gate({ path: '/settings', ...ready })).toEqual({ screen: 'settings' });
    expect(gate({ path: '/login', ...ready })).toEqual({ screen: 'home', redirect: '/' });
    expect(gate({ path: '/setup', ...ready })).toEqual({ screen: 'home', redirect: '/' });
    expect(gate({ path: '/nope', ...ready })).toEqual({ screen: 'home', redirect: '/' });
  });
});
