/**
 * One toast at a time (spec §3.9). A sticky toast (e.g. "Update ready") that a newer toast covers
 * comes back once that one goes, so none is ever lost.
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
/** Sticky toasts covered by a newer toast, the most recently covered last. */
let parked: Toast[] = [];

export function showToast(input: ToastInput): number {
  clearTimeout(timer);
  const current = toast.value;
  // A transient toast is simply replaced; a sticky one waits underneath.
  if (current?.sticky) parked.push(current);
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

/** Hides the toast with this id (or whatever is shown); the sticky toast it covered returns. */
export function dismissToast(id?: number): void {
  const current = toast.value;
  if (!current || (id !== undefined && current.id !== id)) {
    // Not on screen: if it is waiting underneath, it should not come back.
    if (id !== undefined) parked = parked.filter((p) => p.id !== id);
    return;
  }
  clearTimeout(timer);
  toast.value = parked.pop() ?? null;
}
