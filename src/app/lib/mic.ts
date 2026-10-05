/**
 * Will the next microphone request prompt? The Permissions API says 'granted' once the page may
 * capture without asking: a remembered choice, or a grant the browser still holds for this page
 * (WebKit forgets one a while after capture stops). 'unknown' where the API cannot answer for the
 * microphone (older Safari, Firefox): callers then fall back to what the pointer events tell them.
 */
export type MicPermission = 'granted' | 'prompt' | 'denied' | 'unknown';

/** Never throws and never prompts. */
export async function micPermission(): Promise<MicPermission> {
  try {
    const permissions = typeof navigator === 'undefined' ? undefined : navigator.permissions;
    if (!permissions || typeof permissions.query !== 'function') return 'unknown';
    const status = await permissions.query({ name: 'microphone' as PermissionName });
    const state: unknown = status?.state;
    return state === 'granted' || state === 'prompt' || state === 'denied' ? state : 'unknown';
  } catch {
    // Firefox rejects names it does not know with a TypeError.
    return 'unknown';
  }
}
