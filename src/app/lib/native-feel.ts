/**
 * Makes the PWA behave like an installed app rather than a web page: no pinch or double-tap zoom,
 * no rubber-banding, and a composer that stays above the on-screen keyboard. The CSS half lives in
 * styles/native.css; this is the part that needs script (iOS Safari ignores `user-scalable=no`
 * outside Home Screen apps and ignores `touch-action` for page zoom, so gestures are blocked here).
 */

/** Height of the on-screen keyboard in layout-viewport pixels (0 when it is closed). */
export function keyboardInset(innerHeight: number, viewportHeight: number, viewportOffsetTop: number): number {
  return Math.max(0, Math.round(innerHeight - viewportHeight - viewportOffsetTop));
}

export function isStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
}

export function installNativeFeel(): void {
  const root = document.documentElement;
  if (isStandalone()) root.classList.add('standalone');

  // iOS Safari: pinch zoom arrives as gesture events; preventing them keeps the page at scale 1.
  const block = (e: Event) => e.preventDefault();
  document.addEventListener('gesturestart', block, { passive: false });
  document.addEventListener('gesturechange', block, { passive: false });
  document.addEventListener(
    'touchmove',
    (e) => {
      const scale = (e as TouchEvent & { scale?: number }).scale;
      if (scale !== undefined && scale !== 1) e.preventDefault();
    },
    { passive: false },
  );

  // Double-tap zoom on older WebKit builds that ignore `touch-action: manipulation`.
  let lastTouchEnd = 0;
  document.addEventListener(
    'touchend',
    (e) => {
      const now = Date.now();
      if (now - lastTouchEnd < 300 && e.cancelable) e.preventDefault();
      lastTouchEnd = now;
    },
    { passive: false },
  );

  // Keyboard: expose its height so fixed chrome (composer, sheets) can sit above it on iOS, where the
  // layout viewport does not shrink. Chrome Android resizes the layout viewport instead
  // (interactive-widget=resizes-content), which makes the inset 0 there.
  const vv = window.visualViewport;
  if (vv) {
    const update = () => root.style.setProperty('--kb', `${keyboardInset(window.innerHeight, vv.height, vv.offsetTop)}px`);
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    update();
  }
}
