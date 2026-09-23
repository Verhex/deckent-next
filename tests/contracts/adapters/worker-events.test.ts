import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createNormalizerState, flushUnmapped, normalizeClaudeLine, redactText, secretValues } from '#adapters/index.js';
import { summarizeWorkerEvents, workerActivityPhase, workerEventSchema, type WorkerEvent } from '#domain/index.js';

const fixture = new URL('../../fixtures/worker-events/claude-stream.jsonl', import.meta.url);
async function normalize(lines: string[], secrets: string[] = []) {
  const state = createNormalizerState(secrets, 1_000);
  const raw = [...lines.flatMap((line, index) => normalizeClaudeLine(line, state, 1_000 + index * 100)), ...flushUnmapped(state, 99_999)];
  return raw.map(event => workerEventSchema.parse(event)) as WorkerEvent[];
}

it('maps a real Claude stream onto the one current worker event schema with provider totals, tool classes and workspace paths', async () => {
  const lines = (await readFile(fixture, 'utf8')).split('\n').filter(Boolean);
  const events = await normalize(lines);
  expect(events.map(event => event.sequence)).toEqual(events.map((_, index) => index + 1));
  expect(events[0]).toMatchObject({ kind: 'session.started', provider: 'claude', model: 'claude-haiku-4-5-20251001', cliVersion: '2.1.280' });
  expect(events.filter(event => event.kind === 'tool.call').map(event => event.kind === 'tool.call' && [event.name, event.toolClass, event.target, event.detail]))
    .toEqual([['Write', 'write', 'hello.txt', null], ['Read', 'read', 'hello.txt', null], ['Bash', 'shell', null, expect.any(String)]]);
  expect(events.filter(event => event.kind === 'tool.result').every(event => event.kind === 'tool.result' && event.status === 'ok')).toBe(true);
  // Thinking content is never kept, only its size; hooks and thinking-token ticks are ignored, other native types are counted.
  expect(events.filter(event => event.kind === 'message' && event.thinking).every(event => event.kind === 'message' && event.excerpt === '')).toBe(true);
  expect(events.some(event => event.kind === 'quota')).toBe(true);
  const ended = events.find(event => event.kind === 'session.ended');
  expect(ended).toMatchObject({ outcome: 'success', turns: 4, durationMs: 12845, apiDurationMs: 12233, costBasis: 'list',
    tokens: { input: 26, output: 859, cacheRead: 65832, cacheWrite: 12854, thinking: 487 } });
  const summary = summarizeWorkerEvents(events);
  expect(summary).toMatchObject({ provider: 'claude', outcome: 'success', turns: 4, toolErrors: 0, filesTouched: ['hello.txt'],
    toolCalls: { write: 1, read: 1, shell: 1, edit: 0 }, tokens: { input: 26, output: 859, cacheRead: 65832, cacheWrite: 12854 } });
  expect(summary.cacheReadRatio).toBeCloseTo(65832 / (26 + 65832 + 12854), 6);
  expect(workerActivityPhase(events)).toMatchObject({ phase: 'finished' });
  expect(workerActivityPhase(events.slice(0, events.findIndex(event => event.kind === 'tool.call' && event.toolClass === 'write') + 1)))
    .toMatchObject({ phase: 'editing', target: 'hello.txt' });
  // Usage is counted once per API response id even when one response carries several content blocks.
  const usageIds = lines.map(line => JSON.parse(line) as { type: string; message?: { id: string } }).filter(line => line.type === 'assistant').map(line => line.message!.id);
  expect(usageIds.length).toBeGreaterThan(new Set(usageIds).size);
  expect(events.filter(event => event.kind === 'usage')).toHaveLength(new Set(usageIds).size);
});

it('never lets credentials, bearer tokens, key-shaped strings, proxy credentials or authorization headers leave the container', async () => {
  const token = 'eyJhbGciOiJIUzI1NiJ9.c2VjcmV0LWFjY2Vzcy10b2tlbg.c2lnbmF0dXJlLXZhbHVl';
  const secrets = secretValues({ tokens: { access_token: token, refresh_token: 'refresh-secret-value' } });
  const proxy = 'http://127.0.0.1:43123';
  const assistant = (id: string, content: unknown[]) => JSON.stringify({ type: 'assistant', message: { id, content, usage: { input_tokens: 1, output_tokens: 1 } } });
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init', cwd: '/workspace', model: 'm', claude_code_version: 'v' }),
    assistant('a', [{ type: 'text', text: `the token is ${token} and refresh-secret-value; Authorization: Bearer abc.def.ghi` }]),
    assistant('b', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: `curl -H "Authorization: Bearer ${token}" ${proxy}`, description: `export API_KEY=sk-live-0123456789abcdef and token=${token}` } }]),
    assistant('c', [{ type: 'tool_use', id: 't2', name: 'WebFetch', input: { url: 'https://user:hunter2@example.com/path?token=abc' } }]),
    assistant('d', [{ type: 'tool_use', id: 't3', name: 'Read', input: { file_path: '/home/owner/.claude/.credentials.json' } }]),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: `raw output with ${token}`, is_error: true }] } }),
  ];
  const events = await normalize(lines, [...secrets, proxy]);
  const serialized = JSON.stringify(events);
  for (const leaked of [token, 'refresh-secret-value', 'sk-live-0123456789abcdef', 'abc.def.ghi', 'hunter2', 'raw output', proxy]) expect(serialized).not.toContain(leaked);
  expect(serialized).toContain('[REDACTED]');
  expect(events.find(event => event.kind === 'tool.call' && event.name === 'Read')).toMatchObject({ target: '(outside-workspace)/.credentials.json' });
  expect(events.find(event => event.kind === 'tool.result')).toMatchObject({ status: 'error' });
  expect(redactText('x'.repeat(500), [], 240)).toHaveLength(240);
});

it('counts unknown native events instead of dropping them and rejects events outside the current schema', async () => {
  const events = await normalize(['not json', JSON.stringify({ type: 'brand_new_event' }), JSON.stringify({ type: 'system', subtype: 'thinking_tokens' }),
    JSON.stringify({ type: 'system', subtype: 'future_subtype' })]);
  expect(events).toEqual([expect.objectContaining({ kind: 'unmapped', nativeType: 'non-json', count: 1 }), expect.objectContaining({ kind: 'unmapped', nativeType: 'brand_new_event', count: 1 }),
    expect.objectContaining({ kind: 'unmapped', nativeType: 'system:future_subtype', count: 1 })]);
  expect(workerEventSchema.safeParse({ schemaVersion: 2, sequence: 1, atMs: 0, kind: 'unmapped', nativeType: 'x', count: 1 }).success).toBe(false);
  expect(workerEventSchema.safeParse({ schemaVersion: 1, sequence: 1, atMs: 0, kind: 'message', role: 'assistant', textBytes: 1, thinking: false, excerpt: 'x'.repeat(241) }).success).toBe(false);
});
