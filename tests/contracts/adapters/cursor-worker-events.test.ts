import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createCodexState, createCursorState, createNativeLineObserver, createNormalizerState, flushUnmapped, normalizeCursorLine } from '#adapters/index.js';
import { summarizeWorkerEvents, workerEventSchema, workerReportLimits, type WorkerEvent } from '#domain/index.js';
// The standalone bridge's report collector is a mounted-file internal with no package export (no host imports there).
// eslint-disable-next-line no-restricted-imports
import { finalReportCollector } from '#adapters/core/native-connection/internal/worker.js';

// Real cursor-agent 2026.10.19-6bbf2c4 stream-json captures (2026-10-22). Only the host probe directory was replaced by /workspace;
// session, request, call and model-call ids are the captured values (not secrets). No real `is_error: true` stream exists yet:
// every test of that branch is named synthetic-shape.
const fixture = (name: string) => readFileSync(new URL(`../../fixtures/native-cursor/${name}.jsonl`, import.meta.url), 'utf8');
const lines = (name: string) => fixture(name).split('\n').filter(Boolean);
const normalize = (input: readonly string[], secrets: readonly string[] = []) => {
  const state = createNormalizerState(secrets, 0), cursor = createCursorState();
  const events = [...input.flatMap((line, index) => normalizeCursorLine(line, state, cursor, 100 + index * 10)), ...flushUnmapped(state, 99_999)];
  return events.map(event => workerEventSchema.parse(event));
};
const kinds = (events: readonly WorkerEvent[]) => events.map(event => event.kind);
const report = { schemaVersion: 1, summary: 'Done', changedFiles: ['out.txt'], checks: [{ command: 'npm test', outcome: 'passed' }], openIssues: [] };
const resultLine = (result: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'result', subtype: 'success', duration_ms: 5, duration_api_ms: 5,
  is_error: false, result, session_id: '00000000-0000-4000-8000-000000000000', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, ...extra });
const collect = (input: readonly string[], secrets: readonly string[] = []) => {
  const collector = finalReportCollector('cursor', secrets, workerReportLimits, 'final-text-json');
  const observer = createNativeLineObserver('cursor-agent-stream-json', createNormalizerState(secrets), createCodexState(), () => {}, collector);
  observer.observe(Buffer.from(input.map(line => line + '\n').join(''))); observer.flush();
  return collector.finish();
};

describe('Cursor stream normalizer on real cursor-agent streams', () => {
  it('maps the ask-mode probe to start, thinking, message and a measured end with derived turns', () => {
    const events = normalize(lines('probe'));
    expect(kinds(events)).toEqual(['session.started', 'message', 'message', 'session.ended']);
    expect(events[0]).toMatchObject({ provider: 'cursor', model: 'Composer 2.5', cliVersion: null });
    expect(events[1]).toMatchObject({ role: 'assistant', thinking: true, excerpt: '', textBytes: Buffer.byteLength('The user requested a single-word response.') });
    expect(events[2]).toMatchObject({ thinking: false, excerpt: 'ok', textBytes: 2 });
    expect(events[3]).toEqual({ schemaVersion: 1, sequence: 4, atMs: 170, kind: 'session.ended', outcome: 'success', turns: 1, durationMs: 2911, apiDurationMs: 2911,
      costUsd: null, costBasis: null, tokens: { input: 10478, output: 101, cacheRead: 4025, cacheWrite: 0, thinking: null }, permissionDenials: 0 });
    // Cursor reports no per-model usage: no `models` list is claimed (model evidence is the C2 start-name capability).
    expect(events[3]).not.toHaveProperty('models');
  });

  it('maps read and edit tool calls by the data table, once per call id, with workspace-relative targets', () => {
    const events = normalize(lines('probe2'));
    expect(kinds(events)).toEqual(['session.started', 'message', 'tool.call', 'tool.result', 'message', 'tool.call', 'tool.result', 'message', 'message', 'session.ended']);
    expect(events.filter(event => event.kind === 'tool.call')).toEqual([
      expect.objectContaining({ toolId: 'tool_fcc1de21-f90e-4ce4-88c7-8e285caa5e5', name: 'readToolCall', toolClass: 'read', target: 'note.txt', detail: null }),
      expect.objectContaining({ toolId: 'tool_ca1988fa-c9ac-49fe-8a98-8963a3b1ff8', name: 'editToolCall', toolClass: 'edit', target: 'out.txt', detail: null })]);
    expect(events.filter(event => event.kind === 'tool.result').map(event => event.kind === 'tool.result' && [event.toolId, event.status, event.bytes > 0]))
      .toEqual([['tool_fcc1de21-f90e-4ce4-88c7-8e285caa5e5', 'ok', true], ['tool_ca1988fa-c9ac-49fe-8a98-8963a3b1ff8', 'ok', true]]);
    const summary = summarizeWorkerEvents(events);
    expect(summary).toMatchObject({ provider: 'cursor', model: 'Composer 2.5', outcome: 'success', turns: 1, durationMs: 10045, apiDurationMs: 10045, costUsd: null,
      tokenUsageRecorded: true, tokens: { input: 10551, output: 308, cacheRead: 32669, cacheWrite: 0, thinking: null }, filesTouched: ['out.txt'], toolErrors: 0, unmapped: 0, messages: 4 });
    expect(summary.toolCalls).toMatchObject({ read: 1, edit: 1, other: 0 });
    // Tool output (file content) never leaves the normalizer.
    expect(JSON.stringify(events)).not.toContain('hello-from-file');
  });

  it('records the reported start name of an Auto session as is (verdict is the host model-evidence lane)', () => {
    const events = normalize(lines('auto'));
    expect(events[0]).toMatchObject({ kind: 'session.started', model: 'Auto' });
    expect(events.at(-1)).toMatchObject({ kind: 'session.ended', outcome: 'success', turns: 1, tokens: { input: 15737, output: 150, cacheRead: 0, cacheWrite: 0 } });
  });

  it('never fabricates an end for a killed stream: the summary stays running exactly like a Claude session without a result', () => {
    const events = normalize(lines('killed'));
    // Thinking deltas without `completed` are accumulated bytes only, never a message; no `result` line means no session.ended.
    expect(kinds(events)).toEqual(['session.started']);
    expect(summarizeWorkerEvents(events)).toMatchObject({ provider: 'cursor', model: 'Composer 2.5', outcome: 'running', turns: null, durationMs: null, tokenUsageRecorded: false });
    expect(collect(lines('killed'))).toEqual({ status: 'unavailable', reason: 'missing' });
  });

  it('normalizes the same events through the stream-keyed line observer across arbitrary chunk boundaries', () => {
    const state = createNormalizerState([], 0), delivered: unknown[] = [];
    const observer = createNativeLineObserver('cursor-agent-stream-json', state, createCodexState(), events => delivered.push(...events));
    const bytes = Buffer.from(fixture('probe2'));
    for (let at = 0; at < bytes.length; at += 37) observer.observe(bytes.subarray(at, at + 37));
    observer.flush();
    expect((delivered as WorkerEvent[]).map(event => event.kind)).toEqual(kinds(normalize(lines('probe2'))));
    // An unknown stream format is counted, never guessed.
    const unknown = createNormalizerState([], 0);
    createNativeLineObserver('unknown-stream', unknown, createCodexState(), () => { throw new Error('no events expected'); }).observe(Buffer.from(lines('probe')[0] + '\n'));
    expect([...unknown.unmapped]).toEqual([['unknown-stream-event', 1]]);
  });
});

describe('Cursor normalizer edge shapes (synthetic-shape: no real capture of these branches)', () => {
  const started = (key: string, value: Record<string, unknown>) => JSON.stringify({ type: 'tool_call', subtype: 'started', call_id: 'call-1', tool_call: { [key]: value, toolCallId: 'call-1', hookAdditionalContexts: [] } });
  const completed = (key: string, value: Record<string, unknown>) => started(key, value).replace('"started"', '"completed"');
  it('synthetic-shape: an is_error result ends the session as error and a missing usage record is unknown, not zero', () => {
    const ended = normalize([JSON.stringify({ type: 'result', subtype: 'error', is_error: true, duration_ms: 7, result: 'boom' })]).find(event => event.kind === 'session.ended');
    expect(ended).toMatchObject({ outcome: 'error', turns: 0, durationMs: 7, apiDurationMs: null, tokens: null });
    const flagged = normalize([JSON.stringify({ type: 'result', subtype: 'success', is_error: true, usage: 'bad' })]);
    expect(flagged.find(event => event.kind === 'session.ended')).toMatchObject({ outcome: 'error', tokens: null });
    expect(flagged.find(event => event.kind === 'unmapped')).toMatchObject({ nativeType: 'usage-invalid', count: 1 });
  });

  // REVISE 2730 R1: a usage object is a measurement only when all four counters are safe non-negative integers; anything else stays unknown.
  const counters = { inputTokens: 3, outputTokens: 4, cacheReadTokens: 5, cacheWriteTokens: 6 };
  it.each([['empty', {}], ['missing cacheWriteTokens', { inputTokens: 3, outputTokens: 4, cacheReadTokens: 5 }], ['partial with a string', { inputTokens: 'bad', outputTokens: 5 }],
    ['string counter', { ...counters, outputTokens: '4' }], ['negative', { ...counters, cacheReadTokens: -1 }], ['fractional', { ...counters, inputTokens: 1.5 }],
    ['unsafe', { ...counters, cacheWriteTokens: Number.MAX_SAFE_INTEGER + 1 }], ['null counter', { ...counters, inputTokens: null }]])(
    'synthetic-shape: %s usage stays unknown (tokens null) with a usage-invalid diagnostic, never a measured zero', (_name, usage) => {
      const events = normalize([resultLine('done', { usage })]);
      expect(events.find(event => event.kind === 'session.ended')).toMatchObject({ outcome: 'success', tokens: null });
      expect(events.filter(event => event.kind === 'unmapped').map(event => event.kind === 'unmapped' && [event.nativeType, event.count])).toEqual([['usage-invalid', 1]]);
      expect(summarizeWorkerEvents(events).tokenUsageRecorded).toBe(false);
    });

  it('synthetic-shape: valid all-zero usage is a measured zero; valid counters are kept exactly', () => {
    const zero = normalize([resultLine('done', { usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } })]);
    expect(zero.find(event => event.kind === 'session.ended')).toMatchObject({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: null } });
    expect(zero.some(event => event.kind === 'unmapped')).toBe(false);
    expect(summarizeWorkerEvents(zero)).toMatchObject({ tokenUsageRecorded: true, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    expect(normalize([resultLine('done', { usage: counters })]).find(event => event.kind === 'session.ended')).toMatchObject({ tokens: { input: 3, output: 4, cacheRead: 5, cacheWrite: 6, thinking: null } });
  });

  // REVISE 2730 R2: one terminal result per session; a later result never produces a second end that would override the first.
  it('synthetic-shape: a second result keeps the first end (error stays error) and is counted as result:duplicate', () => {
    const failed = JSON.stringify({ type: 'result', subtype: 'error', is_error: true, duration_ms: 7, result: 'boom' });
    const events = normalize([failed, resultLine(JSON.stringify(report))]);
    expect(events.filter(event => event.kind === 'session.ended')).toEqual([expect.objectContaining({ outcome: 'error', durationMs: 7, tokens: null })]);
    expect(events.filter(event => event.kind === 'unmapped').map(event => event.kind === 'unmapped' && [event.nativeType, event.count])).toEqual([['result:duplicate', 1]]);
    expect(summarizeWorkerEvents(events)).toMatchObject({ outcome: 'error', unmapped: 1 });
    const success = normalize([resultLine('done'), failed]);
    expect(success.filter(event => event.kind === 'session.ended')).toEqual([expect.objectContaining({ outcome: 'success' })]);
  });

  it('synthetic-shape: unknown tool keys stay visible as other and are counted; a result without success is an error', () => {
    const events = normalize([started('grepToolCall', { args: { pattern: 'x' } }), completed('grepToolCall', { args: { pattern: 'x' }, result: { error: { message: 'denied' } } }),
      completed('function', { name: 'mcp_lookup', arguments: '{}', result: { success: {} } }).replaceAll('call-1', 'call-2'),
      completed('writeToolCall', { args: { path: '/workspace/new.txt' } }).replaceAll('call-1', 'call-3')]);
    expect(events.filter(event => event.kind === 'tool.call')).toEqual([
      expect.objectContaining({ toolId: 'call-1', name: 'grepToolCall', toolClass: 'other' }),
      expect.objectContaining({ toolId: 'call-2', name: 'mcp_lookup', toolClass: 'other' }),
      expect.objectContaining({ toolId: 'call-3', name: 'writeToolCall', toolClass: 'write', target: 'new.txt' })]);
    expect(events.filter(event => event.kind === 'tool.result').map(event => event.kind === 'tool.result' && event.status)).toEqual(['error', 'ok']);
    expect(events.filter(event => event.kind === 'unmapped').map(event => event.kind === 'unmapped' && [event.nativeType, event.count]))
      .toEqual([['tool_call:grepToolCall', 1], ['tool_call:result-missing', 1]]);
  });

  it('synthetic-shape: malformed lines and unknown types are counted and never throw; secrets in text are redacted', () => {
    const events = normalize(['not json', '[]', JSON.stringify({ type: 'tool_call', subtype: 'started', tool_call: {} }), JSON.stringify({ type: 'mystery' }),
      JSON.stringify({ type: 'thinking', subtype: 'other' }), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'key fixture-cursor-secret' }, { type: 'image' }] } })],
    ['fixture-cursor-secret']);
    expect(JSON.stringify(events)).not.toContain('fixture-cursor-secret');
    expect(events.find(event => event.kind === 'message')).toMatchObject({ excerpt: 'key [REDACTED]' });
    expect(events.filter(event => event.kind === 'unmapped').map(event => event.kind === 'unmapped' && event.nativeType).sort())
      .toEqual(['assistant:image', 'mystery', 'non-json', 'non-object', 'thinking:other', 'tool_call:started']);
  });
});

describe('final-text-json report channel (selected by the capability channel, not the provider)', () => {
  it('reads the report from the final result text, unwraps one whole fenced block and redacts every string leaf', () => {
    expect(collect([resultLine(JSON.stringify(report))])).toEqual({ status: 'reported', report });
    expect(collect([resultLine('```json\n' + JSON.stringify(report) + '\n```')])).toEqual({ status: 'reported', report });
    expect(collect([resultLine('\n```\n' + JSON.stringify(report) + '\n```\n')])).toEqual({ status: 'reported', report });
    const secret = collect([resultLine(JSON.stringify({ ...report, summary: 'Done fixture-cursor-secret', openIssues: ['Bearer abc.def.ghi'] }))], ['fixture-cursor-secret']);
    expect(secret).toMatchObject({ status: 'reported', report: { summary: 'Done [REDACTED]', openIssues: ['Bearer [REDACTED]'] } });
    // Strict-schema transport nulls become absence, like the schema-file channel.
    expect(collect([resultLine(JSON.stringify({ ...report, handoff: null, exit: null, checks: [{ command: 'npm test', outcome: 'passed', checkId: null, role: null }] }))]))
      .toEqual({ status: 'reported', report });
  });

  it('refuses prose, a fence inside prose, a non-report object and extra authority fields as invalid', () => {
    for (const text of ['Here is the report: ' + JSON.stringify(report), 'Done.\n```json\n' + JSON.stringify(report) + '\n```', '{"status":"done"}',
      JSON.stringify({ ...report, accepted: true }), '```json\n' + JSON.stringify(report) + '\n```\n```json\n{}\n```']) {
      expect(collect([resultLine(text)])).toEqual({ status: 'unavailable', reason: 'invalid' });
    }
    // The real probe answered `{"status":"done"}`: an answer that is not a report is invalid, never accepted.
    expect(collect(lines('probe2'))).toEqual({ status: 'unavailable', reason: 'invalid' });
  });

  it('reports missing for no result, an empty answer or a failed result, and oversized for a report or line over its bound', () => {
    expect(collect(lines('probe').slice(0, -1))).toEqual({ status: 'unavailable', reason: 'missing' });
    expect(collect([resultLine('  ')])).toEqual({ status: 'unavailable', reason: 'missing' });
    expect(collect([resultLine(42)])).toEqual({ status: 'unavailable', reason: 'missing' });
    // synthetic-shape: a failed result carries an error text, not a report.
    expect(collect([resultLine(JSON.stringify(report), { subtype: 'error', is_error: true })])).toEqual({ status: 'unavailable', reason: 'missing' });
    expect(collect([resultLine(JSON.stringify(report), { is_error: true })])).toEqual({ status: 'unavailable', reason: 'missing' });
    expect(collect([resultLine(JSON.stringify({ ...report, summary: 'x'.repeat(40000) }))])).toEqual({ status: 'unavailable', reason: 'oversized' });
    expect(collect([resultLine('x'.repeat(1_048_577))])).toEqual({ status: 'unavailable', reason: 'oversized' });
  });

  // REVISE 2730 R2: exactly one terminal `result`, and it is the last record. Permitted after it: no record of any type (every real capture —
  // probe, probe2, auto — ends with its single `result` line; killed and err-model have none). Blank lines are not records.
  const valid = resultLine(JSON.stringify(report)), failed = resultLine('boom', { subtype: 'error', is_error: true });
  it('reads exactly one terminal result that is the last record (blank lines are not records)', () => {
    expect(collect([valid])).toEqual({ status: 'reported', report });
    expect(collect([valid, '', '  '])).toEqual({ status: 'reported', report });
    expect(collect([failed])).toEqual({ status: 'unavailable', reason: 'missing' });
  });

  const assistant = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'one more thing' }] }, session_id: 's' });
  const tool = JSON.stringify({ type: 'tool_call', subtype: 'started', call_id: 'call-9', tool_call: { editToolCall: { args: { path: '/workspace/x' } } }, session_id: 's' });
  const thinking = JSON.stringify({ type: 'thinking', subtype: 'delta', text: 'hmm', session_id: 's' });
  it.each([['assistant', [assistant]], ['tool_call', [tool]], ['thinking', [thinking]], ['tool_call then assistant', [tool, assistant]],
    ['system', [JSON.stringify({ type: 'system', subtype: 'init' })]], ['unknown type', [JSON.stringify({ type: 'mystery' })]], ['non-JSON text', ['not json']],
    ['an over-bound line', ['x'.repeat(1_048_577)]]])('refuses a valid terminal result followed by %s before EOF (no stale report)', (_name, after) => {
    expect(collect([valid, ...after])).toEqual({ status: 'unavailable', reason: 'invalid' });
  });

  it.each([['error then success (the failure is never erased)', [failed, valid]], ['success then error', [valid, failed]], ['duplicate success', [valid, valid]],
    ['contradictory success', [valid, resultLine(JSON.stringify({ ...report, summary: 'Other' }))]]])('refuses a second result: %s', (_name, input) => {
    expect(collect(input)).toEqual({ status: 'unavailable', reason: 'invalid' });
  });

  it('reads one valid terminal report at the end of a real captured stream', () => {
    // probe2 (real tool-using stream) with only its final answer text replaced by a valid report: one terminal result, last record.
    const real = lines('probe2'), last = JSON.parse(real.at(-1)!) as Record<string, unknown>;
    expect(collect([...real.slice(0, -1), JSON.stringify({ ...last, result: JSON.stringify(report) })])).toEqual({ status: 'reported', report });
  });

  it('keeps the flag channels on their native readers when no final-text channel is declared', () => {
    const claude = finalReportCollector('claude', [], workerReportLimits, 'inline-json');
    claude.observe(resultLine(JSON.stringify(report)));
    expect(claude.finish()).toEqual({ status: 'unavailable', reason: 'missing' });
  });
});
