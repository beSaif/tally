/**
 * Bottom sheet over a white dim (design A.2): Escape closes, Tab stays inside, focus returns to
 * where it was. `focusKey` re-focuses the first control when the content changes state.
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
  focusKey?: string;
  /** Initial focus target inside the sheet (CSS selector); defaults to the first control. */
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
      if (!first || !last) {
        e.preventDefault();
        root.focus();
        return;
      }
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !root.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !root.contains(active))) {
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
    const target = (initialFocus && root.querySelector<HTMLElement>(initialFocus)) || focusables(root)[0] || root;
    if (!root.contains(document.activeElement) || document.activeElement === root || focusKey !== undefined) {
      target.focus({ preventScroll: true });
    }
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
