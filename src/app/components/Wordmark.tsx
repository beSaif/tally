import { ReceiptGlyph } from './Icons';

/** Receipt glyph + "Tally" (design: Geist 800 15px, 18px icon with 4px radius). */
export default function Wordmark() {
  return (
    <span class="wordmark">
      <ReceiptGlyph />
      Tally
    </span>
  );
}
