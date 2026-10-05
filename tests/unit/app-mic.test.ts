/** Whether the microphone will prompt (src/app/lib/mic.ts): the Permissions API's answer, or 'unknown' when it has none. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { micPermission } from '@app/lib/mic';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('micPermission', () => {
  it.each(['granted', 'prompt', 'denied'] as const)('passes %s through', async (state) => {
    const query = vi.fn(async () => ({ state }));
    vi.stubGlobal('navigator', { permissions: { query } });
    expect(await micPermission()).toBe(state);
    expect(query).toHaveBeenCalledWith({ name: 'microphone' });
  });

  it('is unknown when the API rejects the name (Firefox), is missing, or answers something else', async () => {
    vi.stubGlobal('navigator', {
      permissions: {
        query: async () => {
          throw new TypeError("'microphone' is not a valid value for enumeration PermissionName.");
        },
      },
    });
    expect(await micPermission()).toBe('unknown');

    vi.stubGlobal('navigator', {});
    expect(await micPermission()).toBe('unknown');

    vi.stubGlobal('navigator', { permissions: {} });
    expect(await micPermission()).toBe('unknown');

    vi.stubGlobal('navigator', { permissions: { query: async () => ({ state: 'maybe' }) } });
    expect(await micPermission()).toBe('unknown');

    vi.stubGlobal('navigator', undefined);
    expect(await micPermission()).toBe('unknown');
  });
});
