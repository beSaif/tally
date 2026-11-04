/**
 * Bottom sheet over a white dim (design A.2): Escape closes, Tab stays inside, focus returns to
 * where it was. The dialog itself takes focus when it opens or changes state (`focusKey`), so a
 * screen reader announces it and no control wears a focus ring the person did not ask for; Tab
 * then walks the controls.
 *
 * While it is open the page underneath stays put: a swipe on the dim, or on a sheet with nothing
 * left to scroll that way, is not handed to the page (iOS Safari scrolls it despite
 * `overflow: hidden`). When the keyboard opens and the sheet shrinks above it, the focused field
 * is scrolled back into view.
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
}

/** Can `el`, or something between it and `root`, scroll by `dy` (a finger moving down is dy > 0)? */
export function canScroll(el: Element | null, root: Element, dy: number): boolean {
  for (let node = el; node; node = node === root ? null : node.parentElement) {
    if (!(node instanceof HTMLElement)) continue;
    const overflowY = getComputedStyle(node).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 1) {
      if (dy > 0 && node.scrollTop > 0) return true; // finger down: content moves down, towards the top
      if (dy < 0 && node.scrollTop + node.clientHeight < node.scrollHeight - 1) return true;
    }
  }
  return false;
}

export interface SheetProps {
  label: string;
  onClose?: () => void;
  children: ComponentChildren;
  /** A new value re-focuses the sheet (the content changed state). */
  focusKey?: string;
  class?: string;
}

export default function Sheet({ label, onClose, children, focusKey, class: cls }: SheetProps) {
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
    let lastX = 0;
    let lastY = 0;
    const onTouchStart = (e: TouchEvent) => {
      lastX = e.touches[0]?.clientX ?? 0;
      lastY = e.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      const root = ref.current;
      const touch = e.touches[0];
      if (!root || !touch || e.touches.length > 1 || !e.cancelable) return;
      const dx = touch.clientX - lastX;
      const dy = touch.clientY - lastY;
      lastX = touch.clientX;
      lastY = touch.clientY;
      if (Math.abs(dx) > Math.abs(dy)) return; // sideways (a caret drag in a field): the page cannot go that way anyway
      const target = e.target instanceof Element ? e.target : null;
      if (!target || !root.contains(target) || !canScroll(target, root, dy)) e.preventDefault();
    };
    // The keyboard opened (or closed): the sheet's height changed, keep the field being typed in visible.
    const vv = window.visualViewport;
    let frame = 0;
    const onViewport = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const active = document.activeElement;
        if (active instanceof HTMLElement && active !== ref.current && ref.current?.contains(active)) {
          active.scrollIntoView({ block: 'nearest' });
        }
      });
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    vv?.addEventListener('resize', onViewport);
    document.body.classList.add('has-sheet');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchmove', onTouchMove);
      vv?.removeEventListener('resize', onViewport);
      cancelAnimationFrame(frame);
      document.body.classList.remove('has-sheet');
      // Re-focusing a text field would pop the keyboard back up on phones; only restore buttons etc.
      if (previous && previous.isConnected && !(previous instanceof HTMLInputElement && previous.type !== 'checkbox')) {
        previous.focus({ preventScroll: true });
      }
    };
  }, []);

  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
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
