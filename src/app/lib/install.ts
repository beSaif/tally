/**
 * "Add to Home Screen": captures `beforeinstallprompt` early (it fires once, before the UI needs it)
 * and offers a one-time install toast. iOS has no prompt; Settings shows the Share-sheet how-to.
 */
import { signal } from '@preact/signals';
import { isStandalone } from './push';
import { showToast } from './toast';
import { lang, translate } from '../i18n';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export const installPrompt = signal<BeforeInstallPromptEvent | null>(null);
export const installed = signal(false);

const OFFERED_KEY = 'tally.installOffered';

export function initInstall(): void {
  installed.value = isStandalone();
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt.value = e as BeforeInstallPromptEvent;
  });
  window.addEventListener('appinstalled', () => {
    installPrompt.value = null;
    installed.value = true;
  });
}

export async function promptInstall(): Promise<boolean> {
  const e = installPrompt.value;
  if (!e) return false;
  installPrompt.value = null; // a prompt event can only be used once
  await e.prompt();
  const choice = await e.userChoice.catch(() => ({ outcome: 'dismissed' as const }));
  return choice.outcome === 'accepted';
}

/** Offers installation once per device, after something was logged (the moment it is useful). */
export function offerInstallOnce(): void {
  if (!installPrompt.value || installed.value) return;
  try {
    if (localStorage.getItem(OFFERED_KEY)) return;
    localStorage.setItem(OFFERED_KEY, '1');
  } catch {
    return;
  }
  showToast({
    text: translate(lang.value, 'toast.install'),
    actionLabel: translate(lang.value, 'toast.installAction'),
    onAction: () => void promptInstall(),
    duration: 8000,
  });
}
