import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { meteredDb, QueryMeter } from '../../src/worker/lib/d1-meter';

describe('meteredDb', () => {
  it('counts every statement it runs, the way D1 does', async () => {
    const meter = new QueryMeter();
    const db = meteredDb(env.DB, meter);

    const one = db.prepare('SELECT ? AS n').bind(1);
    expect(await one.first<{ n: number }>()).toEqual({ n: 1 });
    expect(await one.first<number>('n')).toBe(1);
    expect((await one.all<{ n: number }>()).results).toEqual([{ n: 1 }]);
    expect((await one.run()).success).toBe(true);
    expect(await one.raw()).toEqual([[1]]);
    expect(await one.raw({ columnNames: true })).toEqual([['n'], [1]]);
    expect(meter.used).toBe(6);

    // Each statement of a batch counts, and a batch takes the metered statements as they are.
    const results = await db.batch<{ n: number }>([db.prepare('SELECT 2 AS n'), db.prepare('SELECT ? AS n').bind(3), env.DB.prepare('SELECT 4 AS n')]);
    expect(results.map((r) => r.results[0]?.n)).toEqual([2, 3, 4]);
    expect(meter.used).toBe(9);

    // Preparing and binding are free.
    db.prepare('SELECT 5').bind();
    expect(meter.used).toBe(9);
  });

  it('counts exec by the statements it ran, and meters sessions too', async () => {
    const meter = new QueryMeter();
    const db = meteredDb(env.DB, meter);
    const exec = await db.exec('SELECT 1; SELECT 2;');
    expect(meter.used).toBe(exec.count);

    const before = meter.used;
    const session = db.withSession('first-unconstrained');
    await session.prepare('SELECT 1').first();
    await session.batch([session.prepare('SELECT 1'), session.prepare('SELECT 2')]);
    expect(meter.used).toBe(before + 3);
  });

  it('nests: an outer meter sees what an inner one counts', async () => {
    const outer = new QueryMeter();
    const inner = new QueryMeter();
    const db = meteredDb(meteredDb(env.DB, outer), inner);
    await db.batch([db.prepare('SELECT 1'), db.prepare('SELECT 2')]);
    await db.prepare('SELECT 3').first();
    expect([inner.used, outer.used]).toEqual([3, 3]);
  });

  it('does not count a statement that cannot be prepared', async () => {
    const meter = new QueryMeter();
    const broken = { prepare: () => { throw new Error('D1 is down'); } } as unknown as D1Database;
    expect(() => meteredDb(broken, meter).prepare('SELECT 1')).toThrow('D1 is down');
    expect(meter.used).toBe(0);
  });
});
