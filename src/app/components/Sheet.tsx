/**
 * Bottom sheet over a white dim (design A.2): Escape closes, Tab stays inside, focus returns to
 * where it was. The dialog itself takes focus when it opens or changes state (`focusKey`), so a
 * screen reader announces it and no control wears a focus ring the person did not ask for; Tab
 * then walks the controls. `initialFocus` (a CSS selector) moves focus to a field instead.
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
}

export interface SheetProps {
  label: string;
  onClose?: () => void;
  children: ComponentChildren;
  /** A new value re-focuses the sheet (the content changed state). */
  focusKey?: string;
  /** Focus target inside the sheet (CSS selector); defaults to the dialog itself. */
  initialFocus?: string;
  class?: string;
}

export default function Sheet({ label, onClose, children, focusKey, initialFocus, class: cls }: SheetProps) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKey = (e: KeyboardEvent) => {
      const root = ref.current;
      if (!root) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        closeRef.current?.();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables(root);
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!first || !last) {
        e.preventDefault();
        root.focus();
        return;
      }
      if (active === root || !root.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('has-sheet');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('has-sheet');
      // Re-focusing a text field would pop the keyboard back up on phones; only restore buttons etc.
      if (previous && previous.isConnected && !(previous instanceof HTMLInputElement && previous.type !== 'checkbox')) {
        previous.focus({ preventScroll: true });
      }
    };
  }, []);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const target = (initialFocus && root.querySelector<HTMLElement>(initialFocus)) || root;
    target.focus({ preventScroll: true });
  }, [focusKey]);

  return (
    <>
      <div class="dim" onClick={() => closeRef.current?.()} aria-hidden="true" />
      <div class={`sheet${cls ? ` ${cls}` : ''}`} role="dialog" aria-modal="true" aria-label={label} ref={ref} tabIndex={-1}>
        {children}
      </div>
    </>
  );
}
