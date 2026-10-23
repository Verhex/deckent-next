import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createCodexState, createNormalizerState, flushUnmapped, normalizeCodexLine, sealWorkerEventLog } from '#adapters/index.js';
import { summarizeWorkerEvents, workerEventSchema, type WorkerEvent } from '#domain/index.js';

/** Real `codex exec --json` stdout, Codex 0.163.0 (probe 2026-10-23, model gpt-6-luna, ids and paths redacted). */
const stdoutFixture = new URL('../../fixtures/native-codex/exec-0.163.0-ok.stdout.jsonl', import.meta.url);
const lines = async () => (await readFile(stdoutFixture, 'utf8')).split('\n').filter(Boolean);
const normalize = (input: readonly string[]) => {
  const state = createNormalizerState([], 1_000), codex = createCodexState();
  return [...input.flatMap((line, index) => normalizeCodexLine(line, state, codex, 1_000 + index * 10)), ...flushUnmapped(state, 9_999)]
    .map(event => workerEventSchema.parse(event)) as WorkerEvent[];
};

describe('Codex token evidence reaches the sealed attempt log (alpha.54 CX step 0)', () => {
  it('a real Codex stream seals measured tokens: cached input apart, never "no token use"', async () => {
    // Characterization of the shipped path since B09-3 (4eec4552a): stdout → normalizer → schema → seal → summary.
    const sealed = sealWorkerEventLog(normalize(await lines()), null, 0, 1_048_576).map(line => workerEventSchema.parse(JSON.parse(line)) as WorkerEvent);
    const summary = summarizeWorkerEvents(sealed);
    // Expected values are the probe's own `turn.completed.usage`: input 21320 of which cached 11520, output 5, reasoning 0.
    expect(summary).toMatchObject({ outcome: 'success', turns: 1, tokenUsageRecorded: true,
      tokens: { input: 21_320 - 11_520, cacheRead: 11_520, cacheWrite: 0, output: 5, thinking: 0 } });
  });

  it('maps cache_write_input_tokens apart from fresh input: input_tokens includes both cache details (Codex rust-v0.163.0 parses_cache_write_token_usage)', () => {
    // The vendor worked example: input 100 = cached 40 + cache write 60, output 10 of which reasoning 5.
    const events = normalize([JSON.stringify({ type: 'thread.started', thread_id: '00000000-0000-4000-8000-000000000001' }), JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 60, output_tokens: 10, reasoning_output_tokens: 5 } })]);
    expect(events.filter(event => event.kind === 'usage')).toMatchObject([{ tokens: { input: 0, cacheRead: 40, cacheWrite: 60, output: 10, thinking: 5 } }]);
    expect(events.find(event => event.kind === 'session.ended')).toMatchObject({ tokens: { input: 0, cacheRead: 40, cacheWrite: 60, output: 10, thinking: 5 } });
    expect(summarizeWorkerEvents(events).cacheReadRatio).toBeCloseTo(40 / 100);
  });

  it('counts a missing or unsafe cache-write value as zero, never as negative fresh input', () => {
    for (const write of [undefined, -5, 1.5, Number.MAX_SAFE_INTEGER + 2, '60']) {
      const events = normalize([JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: write, output_tokens: 1 } })]);
      expect(events.find(event => event.kind === 'session.ended')).toMatchObject({ tokens: { input: 60, cacheRead: 40, cacheWrite: 0 } });
    }
    // Inconsistent vendor totals never yield negative fresh input.
    const odd = normalize([JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 50, cached_input_tokens: 40, cache_write_input_tokens: 60, output_tokens: 1 } })]);
    expect(odd.find(event => event.kind === 'session.ended')).toMatchObject({ tokens: { input: 0, cacheRead: 40, cacheWrite: 60 } });
  });
});
