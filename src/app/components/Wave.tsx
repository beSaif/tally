import { BAR_TAIL, barHeight } from '../lib/bars';

/**
 * 46 bars, 3px wide, 4–30px tall (design A.2). `live`: orange, with the design's faded tail where
 * the next sound lands; `frozen`: a recording that is no longer listening, in faint grey.
 */
export default function Wave({ values, tone }: { values: readonly number[]; tone: 'live' | 'frozen' }) {
  const n = values.length;
  const live = tone === 'live';
  return (
    <div class={`wave${live ? '' : ' idle'}`} aria-hidden="true">
      {values.map((v, i) => (
        <b key={i} style={{ height: `${barHeight(v)}px`, opacity: live && i >= n - BAR_TAIL ? 0.3 : 1 }} />
      ))}
    </div>
  );
}
