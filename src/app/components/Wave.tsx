import { BAR_TAIL, barHeight } from '../lib/bars';

/** 46 bars, 3px wide, 4–30px tall. `live` = orange with the faded tail; otherwise frozen in faint. */
export default function Wave({ values, live }: { values: readonly number[]; live: boolean }) {
  const n = values.length;
  return (
    <div class={`wave${live ? '' : ' idle'}`} aria-hidden="true">
      {values.map((v, i) => (
        <b key={i} style={{ height: `${barHeight(v)}px`, opacity: live && i >= n - BAR_TAIL ? 0.3 : 1 }} />
      ))}
    </div>
  );
}
