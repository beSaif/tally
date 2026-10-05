/**
 * Line icons (spec §2.3). `mic`, `cam` and `ok` are the design page's exact paths; the rest follow
 * the same style (24px box, 1.8 stroke, round caps). Decorative: buttons carry the aria-label.
 */
import type { ComponentChildren } from 'preact';

function Line({ children, width = 1.8 }: { children: ComponentChildren; width?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={width} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export function IconMic() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true" focusable="false">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    </svg>
  );
}

export function IconCam() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true" focusable="false">
      <path d="M3.5 8h3.2l1.6-2.5h7.4L17.3 8h3.2v11h-17z" />
      <circle cx="12" cy="13" r="3.4" />
    </svg>
  );
}

export function IconOk() {
  return (
    <svg viewBox="0 0 12 12" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
      <path d="M2.5 6.2 5 8.5l4.5-5" />
    </svg>
  );
}

export function IconSend() {
  return (
    <Line>
      <path d="M12 19.5V5M5.8 11.2 12 5l6.2 6.2" />
    </Line>
  );
}

export function IconBack() {
  return (
    <Line>
      <path d="M14.5 5.5 8 12l6.5 6.5" />
    </Line>
  );
}

export function IconGear() {
  return (
    <Line width={1.6}>
      <path d="M9.63 5.84 10.07 3.62H13.93L14.37 5.84 14.68 5.97 16.56 4.71 19.29 7.44 18.03 9.32 18.16 9.63 20.38 10.07V13.93L18.16 14.37 18.03 14.68 19.29 16.56 16.56 19.29 14.68 18.03 14.37 18.16 13.93 20.38H10.07L9.63 18.16 9.32 18.03 7.44 19.29 4.71 16.56 5.97 14.68 5.84 14.37 3.62 13.93V10.07L5.84 9.63 5.97 9.32 4.71 7.44 7.44 4.71 9.32 5.97Z" />
      <circle cx="12" cy="12" r="3" />
    </Line>
  );
}

export function IconClose() {
  return (
    <Line>
      <path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5" />
    </Line>
  );
}

export function IconTrash() {
  return (
    <Line width={1.6}>
      <path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.9 12.5h9.2L17.5 7M10.2 10.5v5.5M13.8 10.5v5.5" />
    </Line>
  );
}

export function IconBell() {
  return (
    <Line width={1.6}>
      <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15zM10 20.5a2 2 0 0 0 4 0" />
    </Line>
  );
}

export function IconPlus() {
  return (
    <Line>
      <path d="M12 5.5v13M5.5 12h13" />
    </Line>
  );
}

export function IconChevronDown() {
  return (
    <Line>
      <path d="M6.5 9.5 12 15l5.5-5.5" />
    </Line>
  );
}

export function IconStop() {
  return (
    <Line>
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
    </Line>
  );
}

// ---- I2 Receipt, the app icon (16×16 pixel grid, spec §2.3) ----
const RECEIPT = [
  '................',
  '...WWWWWWWWWW...',
  '...WWWWWWWWWW...',
  '...WKKKKKWWWW...',
  '...WWWWWWWWWW...',
  '...WKKKWWWKKW...',
  '...WWWWWWWWWW...',
  '...WKKKKWWWKW...',
  '...WWWWWWWWWW...',
  '...WOOOOOOOOW...',
  '...WOOOOOOOOW...',
  '...WWWWWWWWWW...',
  '...WWWWWWWWWW...',
  '...WWWWWWWWWW...',
  '...W.W.W.W.W....',
  '................',
];

/** One path per colour, horizontal runs merged so no hairline seams show at small sizes. */
function runs(color: string): string {
  let d = '';
  RECEIPT.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] !== color) {
        x++;
        continue;
      }
      const start = x;
      while (x < row.length && row[x] === color) x++;
      d += `M${start} ${y}h${x - start}v1h${start - x}z`;
    }
  });
  return d;
}

const WHITE = runs('W');
const ORANGE = runs('O');

export function ReceiptGlyph() {
  return (
    <svg viewBox="0 0 16 16" shape-rendering="crispEdges" aria-hidden="true" focusable="false">
      <rect width="16" height="16" fill="#0B0B0B" />
      <path d={WHITE} fill="#FFFFFF" />
      <path d={ORANGE} fill="#FF4F00" />
    </svg>
  );
}
