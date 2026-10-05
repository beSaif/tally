import { describe, expect, it } from 'vitest';
import { gate } from '@app/lib/gate';
import { defaultCurrency, regionOf } from '@app/lib/region';
import { describeUserAgent, isIOSDevice } from '@app/lib/ua';

describe('auth gate (spec §3)', () => {
  const ready = { authed: true, hasKey: true, setupComplete: true };
  it('sends visitors to the login', () => {
    expect(gate({ path: '/', authed: false, hasKey: false, setupComplete: false })).toEqual({ screen: 'login', redirect: '/login' });
    expect(gate({ path: '/signup', authed: false, hasKey: false, setupComplete: false })).toEqual({ screen: 'signup' });
    expect(gate({ path: '/overview', authed: false, hasKey: true, setupComplete: true })).toEqual({ screen: 'login', redirect: '/login' });
  });
  it('sends an account without a key on this device, or with setup unfinished, to setup', () => {
    expect(gate({ path: '/', authed: true, hasKey: false, setupComplete: true })).toEqual({ screen: 'setup', redirect: '/setup' });
    expect(gate({ path: '/settings', authed: true, hasKey: true, setupComplete: false })).toEqual({ screen: 'setup', redirect: '/setup' });
    expect(gate({ path: '/setup', authed: true, hasKey: false, setupComplete: false })).toEqual({ screen: 'setup' });
  });
  it('routes the app screens and sends everything else home', () => {
    expect(gate({ path: '/', ...ready })).toEqual({ screen: 'home' });
    expect(gate({ path: '/overview/', ...ready })).toEqual({ screen: 'overview' });
    expect(gate({ path: '/settings', ...ready })).toEqual({ screen: 'settings' });
    expect(gate({ path: '/login', ...ready })).toEqual({ screen: 'home', redirect: '/' });
    expect(gate({ path: '/setup', ...ready })).toEqual({ screen: 'home', redirect: '/' });
  });
});

describe('default currency from the device region (spec §3.2)', () => {
  it('reads the region subtag', () => {
    expect(regionOf('fr-CH')).toBe('CH');
    expect(regionOf('zh-Hans-CN')).toBe('CN');
    expect(regionOf('es-419')).toBeNull();
    expect(regionOf('en')).toBeNull();
  });
  it('maps CH to CHF, the euro area to EUR, and falls back to CHF', () => {
    expect(defaultCurrency(['fr-CH'])).toBe('CHF');
    expect(defaultCurrency(['de-DE'])).toBe('EUR');
    expect(defaultCurrency(['en', 'en-GB'])).toBe('GBP');
    expect(defaultCurrency(['en-US'])).toBe('USD');
    expect(defaultCurrency(['en'])).toBe('CHF');
    expect(defaultCurrency([])).toBe('CHF');
  });
});

describe('device names for the push device list', () => {
  it('summarises user agents', () => {
    expect(describeUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36')).toEqual({
      browser: 'Chrome',
      os: 'Android',
    });
    expect(describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')).toEqual({
      browser: 'Safari',
      os: 'iPhone',
    });
    expect(describeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0')).toEqual({
      browser: 'Edge',
      os: 'Windows',
    });
    expect(describeUserAgent(null)).toEqual({ browser: null, os: null });
  });
  it('recognises iPadOS, which says it is a Mac', () => {
    expect(isIOSDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel', 5)).toBe(true);
    expect(isIOSDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel', 0)).toBe(false);
  });
});
