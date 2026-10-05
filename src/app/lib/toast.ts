/**
 * One toast at a time (spec §3.9). A sticky toast (e.g. "Update ready") comes back after a
 * transient one replaces it.
 */
import { signal } from '@preact/signals';

export interface Toast {
  id: number;
  text: string;
  actionLabel?: string;
  onAction?: () => void;
  sticky: boolean;
}

export interface ToastInput {
  text: string;
  actionLabel?: string;
  onAction?: () => void;
  /** Milliseconds; ignored for sticky toasts. */
  duration?: number;
  sticky?: boolean;
}

export const toast = signal<Toast | null>(null);

let nextId = 1;
let timer: ReturnType<typeof setTimeout> | undefined;
let parked: Toast | null = null;

export function showToast(input: ToastInput): number {
  clearTimeout(timer);
  const current = toast.value;
  if (current?.sticky && !input.sticky) parked = current;
  const item: Toast = {
    id: nextId++,
    text: input.text,
    sticky: input.sticky ?? false,
    ...(input.actionLabel ? { actionLabel: input.actionLabel } : {}),
    ...(input.onAction ? { onAction: input.onAction } : {}),
  };
  toast.value = item;
  if (!item.sticky) timer = setTimeout(() => dismissToast(item.id), input.duration ?? 4500);
  return item.id;
}

/** Hides the toast with this id (or whatever is shown); a parked sticky toast returns. */
export function dismissToast(id?: number): void {
  const current = toast.value;
  if (!current || (id !== undefined && current.id !== id)) {
    if (parked && id !== undefined && parked.id === id) parked = null;
    return;
  }
  clearTimeout(timer);
  if (current.sticky) {
    toast.value = null;
    return;
  }
  toast.value = parked;
  parked = null;
}
