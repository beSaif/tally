/**
 * Splits an "ask your data" answer into styled runs (design C.3): amounts in mono, the first
 * category name mentioned in the accent colour, everything else plain.
 */
export type AnswerSegment = { text: string; kind: 'text' | 'amount' | 'category' };

// "1 284.60", "1 284.60" (narrow no-break space), "1'284.60", "42.80", "12,50": two decimals, optional groups.
const AMOUNT = /(?<![\d.,])\d{1,3}(?:[   '’]\d{3})+[.,]\d{2}(?!\d)|(?<![\d.,])\d+[.,]\d{2}(?![\d])/gu;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface Match {
  start: number;
  end: number;
  kind: 'amount' | 'category';
}

function firstCategory(text: string, names: readonly string[]): Match | null {
  let best: Match | null = null;
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, 'iu');
    const m = re.exec(text);
    if (!m) continue;
    const start = m.index;
    const end = start + m[0].length;
    // Earliest wins; on a tie the longer name ("Health care" over "Health").
    if (!best || start < best.start || (start === best.start && end > best.end)) best = { start, end, kind: 'category' };
  }
  return best;
}

export function answerSegments(text: string, categoryNames: readonly string[]): AnswerSegment[] {
  const matches: Match[] = [];
  for (const m of text.matchAll(AMOUNT)) {
    const start = m.index ?? 0;
    matches.push({ start, end: start + m[0].length, kind: 'amount' });
  }
  const cat = firstCategory(text, categoryNames);
  if (cat && !matches.some((m) => cat.start < m.end && m.start < cat.end)) matches.push(cat);
  matches.sort((a, b) => a.start - b.start);

  const out: AnswerSegment[] = [];
  let pos = 0;
  for (const m of matches) {
    if (m.start > pos) out.push({ text: text.slice(pos, m.start), kind: 'text' });
    out.push({ text: text.slice(m.start, m.end), kind: m.kind });
    pos = m.end;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), kind: 'text' });
  return out;
}
