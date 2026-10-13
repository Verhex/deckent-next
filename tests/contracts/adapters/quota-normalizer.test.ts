import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { createNormalizerState, createCodexState, normalizeClaudeLine, normalizeCodexLine } from '#adapters/index.js';
import { workerEventSchema } from '#domain/index.js';
const registry = JSON.parse(readFileSync(new URL('../../../src/adapters/core/native-connection/internal/providers.json', import.meta.url), 'utf8')); 

it.each(['allowed', 'allowed_warning', 'rejected', 'future-status'])('classifies Claude %s using the adapter registry, not overage rejection or utilization', status => {
  const state = createNormalizerState([], 1000, registry.quotaPolicy);
  const events = normalizeClaudeLine(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status, overageStatus: 'rejected',
    rateLimitType: 'five_hour', resetsAt: 6, unifiedWindows: { five_hour: { utilization: 1, resetsAt: 6 } } } }), state, 2000).map(event => workerEventSchema.parse(event));
  expect(events.find(event => event.kind === 'quota')).toMatchObject({ status, utilization: 1, resetsAtMs: 6000 });
  expect(events.filter(event => event.kind === 'quota-exhausted')).toEqual(status === 'rejected'
    ? [expect.objectContaining({ source: 'claude-rate-limit', window: 'five_hour', resetsAtMs: 6000 })] : []);
});
it('keeps unknown reset time null and unconfigured Claude status observational', () => {
  const line = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 'tomorrow' } });
  expect(normalizeClaudeLine(line, createNormalizerState([], 0, registry.quotaPolicy)).map(event => workerEventSchema.parse(event)))
    .toEqual([expect.objectContaining({ kind: 'quota-exhausted', resetsAtMs: null })]);
  expect(normalizeClaudeLine(line, createNormalizerState([]))).toEqual([]);
});
it.each(['turn.failed', 'error', 'item.completed'])('classifies Codex %s quota text without retaining sensitive error prose', type => {
  const message = 'Rate limit exceeded; Authorization: Bearer super-secret-native-token';
  const data = type === 'turn.failed' ? { type, error: { message } } : type === 'error' ? { type, message } : { type, item: { id: 'i', type: 'error', message } };
  const events = normalizeCodexLine(JSON.stringify(data), createNormalizerState(['super-secret-native-token'], 0, registry.quotaPolicy), createCodexState()).map(event => workerEventSchema.parse(event));
  expect(events.find(event => event.kind === 'quota-exhausted')).toMatchObject({ source: 'codex-text', resetsAtMs: null });
  expect(JSON.stringify(events)).not.toContain('super-secret-native-token');
  expect(normalizeCodexLine(JSON.stringify({ type: 'turn.failed', error: { message: 'Permission denied' } }), createNormalizerState([], 0, registry.quotaPolicy), createCodexState())
    .some(event => event.kind === 'quota-exhausted')).toBe(false);
});
