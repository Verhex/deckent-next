import { describe, expect, it } from 'vitest';
import { MonitorSourceMemo, readThrough } from '#engine/index.js';

// MON-CPU-FIX (owner A48-D10): the live monitor recalls ledger/policy/config-derived reads only while a target's generation (viewer + source
// stamps + config object) holds; any other generation, a failure or an untouched key is never answered from the memo.
const counter = () => { let calls = 0; return { compute: async () => { calls += 1; return { calls }; }, get calls() { return calls; } }; };

describe('MonitorSourceMemo', () => {
  it('an unchanged generation answers the same key from the memo across inspections (the work is not repeated)', async () => {
    const memo = new MonitorSourceMemo(), work = counter();
    expect(await memo.recall('/a', 'g1')('workers', work.compute)).toEqual({ calls: 1 });
    expect(await memo.recall('/a', 'g1')('workers', work.compute)).toEqual({ calls: 1 });
    expect(await memo.recall('/a', 'g1')('workers', work.compute)).toEqual({ calls: 1 });
    expect(work.calls).toBe(1);
  });

  it('negative: another generation (another viewer or a changed source stamp) never sees an earlier read', async () => {
    const memo = new MonitorSourceMemo();
    expect(await memo.recall('/a', JSON.stringify(['owner', 'stamp-1']))('runs', async () => 'owner-data')).toBe('owner-data');
    // Same target and key, different viewer: computed again, and the owner's value is gone for good (switching back recomputes too).
    expect(await memo.recall('/a', JSON.stringify(['mcp-workload', 'stamp-1']))('runs', async () => 'workload-data')).toBe('workload-data');
    expect(await memo.recall('/a', JSON.stringify(['owner', 'stamp-1']))('runs', async () => 'owner-again')).toBe('owner-again');
    // A changed stamp is a new generation as well.
    expect(await memo.recall('/a', JSON.stringify(['owner', 'stamp-2']))('runs', async () => 'after-change')).toBe('after-change');
  });

  it('targets are independent: one target changing does not drop or share another target\'s entries', async () => {
    const memo = new MonitorSourceMemo(), work = counter();
    await memo.recall('/a', 'g')('k', work.compute); await memo.recall('/b', 'g')('k', work.compute);
    expect(work.calls).toBe(2);
    await memo.recall('/b', 'g2')('k', work.compute); await memo.recall('/a', 'g')('k', work.compute);
    expect(work.calls).toBe(3);
  });

  it('a null generation (no memo across reads, or still-settling sources) shares within one inspection only and forgets the target', async () => {
    const memo = new MonitorSourceMemo(), work = counter();
    await memo.recall('/a', 'g')('k', work.compute);
    const local = memo.recall('/a', null); await local('k', work.compute); await local('k', work.compute);
    expect(work.calls).toBe(2);
    await memo.recall('/a', null)('k', work.compute);
    await memo.recall('/a', 'g')('k', work.compute);
    expect(work.calls).toBe(4);
    expect(await readThrough('k', async () => 'fresh')).toBe('fresh');
  });

  it('negative: a failed compute and a value refused by `keep` are never answered from the memo', async () => {
    const memo = new MonitorSourceMemo();
    let fail = true;
    const flaky = async () => { if (fail) throw new Error('busy'); return 'ok'; };
    await expect(memo.recall('/a', 'g')('k', flaky)).rejects.toThrow('busy');
    fail = false; expect(await memo.recall('/a', 'g')('k', flaky)).toBe('ok');
    let n = 0;
    const transient = async () => ({ unavailable: ++n < 3, n });
    const keep = (value: { unavailable: boolean }) => !value.unavailable;
    expect(await memo.recall('/a', 'g')('t', transient, keep)).toEqual({ unavailable: true, n: 1 });
    expect(await memo.recall('/a', 'g')('t', transient, keep)).toEqual({ unavailable: true, n: 2 });
    expect(await memo.recall('/a', 'g')('t', transient, keep)).toEqual({ unavailable: false, n: 3 });
    expect(await memo.recall('/a', 'g')('t', transient, keep)).toEqual({ unavailable: false, n: 3 });
  });

  it('bounded: an inspection keeps only the keys it touched, so keys of a past live state are dropped', async () => {
    const memo = new MonitorSourceMemo(), work = counter();
    const first = memo.recall('/a', 'g'); await first('usage-1', work.compute); await first('stable', work.compute);
    const second = memo.recall('/a', 'g'); await second('usage-2', work.compute); await second('stable', work.compute);
    expect(work.calls).toBe(3);
    // `usage-1` was not touched by the second inspection: the third computes it again (it was dropped, not kept forever).
    const third = memo.recall('/a', 'g'); await third('usage-1', work.compute); await third('stable', work.compute);
    expect(work.calls).toBe(4);
  });

});
