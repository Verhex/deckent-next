import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { planRun } from '../../../src/index.js';
import { clearConfigCache } from '#platform/index.js';
import { prepareTerminalChatCommand } from '#composition/core/terminal-chat/index.js';
import { assessConfiguredModelInvocationDelivery } from '#composition/core/model-invocation/index.js';
import { brainProviderFixture } from '../support/brain-provider.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); vi.restoreAllMocks(); });
const command = { schemaVersion: 1 as const, scopeId: 's', commandId: 'planner-settings', intent: 'Plan a durable customer purchase' };
type Fixture = Awaited<ReturnType<typeof brainProviderFixture>>;
async function fixture(options: Parameters<typeof brainProviderFixture>[0] = {}) {
  const f = await brainProviderFixture(options); cleanups.push(f.close); return f;
}
async function configure(f: Fixture, settings: Record<string, unknown>) {
  await writeFile(join(f.project, '.deckent/config.json'), JSON.stringify({ ...f.config, brain_planner: settings })); clearConfigCache();
}
function stored(f: Fixture) {
  const db = new DatabaseSync(f.path, { readOnly: true });
  try { return { runs: Number(db.prepare('SELECT count(*) AS n FROM runs').get()!.n),
    proposals: Number(db.prepare('SELECT count(*) AS n FROM run_proposals').get()!.n) }; } finally { db.close(); }
}
describe.skipIf(process.platform === 'win32')('Brain invocation settings through the governed SDK', () => {
  it.each([undefined, null, 64])('uses planner cap %s independently of chat, with the exact cap in counting and spending', async maxCompletionTokens => {
    const f = await fixture({ thinking: 'supported', maxOutputTokens: 64, tokenCount: { count: 10, max_model_len: 1000 } });
    await configure(f, maxCompletionTokens === undefined ? {} : { maxCompletionTokens });
    const result = await planRun(f.project, command, f.options), request = JSON.parse(f.bodies[0]!);
    const expected = maxCompletionTokens ?? 8;
    expect(request.max_completion_tokens).toBe(expected); expect(request).not.toHaveProperty('chat_template_kwargs');
    expect(JSON.parse(f.counterBodies[0]!).messages).toEqual(request.messages);
    expect((await prepareTerminalChatCommand({ projectRoot: f.project, scopeId: 's', messages: [], options: f.options }, false)).command.nativeRequest['max_completion_tokens']).toBe(8);
    const source = result.proposal.proposal.source;
    if (source.kind !== 'model') throw new Error('EXPECTED_MODEL_SOURCE');
    const db = new DatabaseSync(f.path, { readOnly: true });
    try {
      const row = db.prepare('SELECT record FROM model_invocation_spend_reservations').get()!;
      expect(JSON.parse(String(row.record)).descriptor.quote.meter.evidence.calculation.outputBound).toBe(expected);
    } finally { db.close(); }
    expect(f.posts).toBe(1); expect(stored(f)).toEqual({ runs: 0, proposals: 1 });
    await configure(f, { maxCompletionTokens: 32, reasoning: 'off' });
    expect(await planRun(f.project, command, f.options)).toEqual(result);
    expect(f.posts).toBe(1); expect(f.counterBodies).toHaveLength(1);
  });
  it('sends explicit off only to a supported binding; measurement and native POST keep the same template switch', async () => {
    const f = await fixture({ thinking: 'supported', tokenCount: { count: 10 } });
    await configure(f, { reasoning: 'off' });
    await planRun(f.project, command, f.options);
    expect(JSON.parse(f.bodies[0]!).chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(JSON.parse(f.counterBodies[0]!).chat_template_kwargs).toEqual({ enable_thinking: false });
  });
  it.each([undefined, 'unsupported', 'unknown', 'wrong-version', 'wrong-protocol'] as const)('refuses off with capability %s before measurement or POST', async thinking => {
    const f = await fixture({ ...(thinking ? { thinking } : {}), tokenCount: { count: 10 } });
    await configure(f, { reasoning: 'off' });
    await expect(planRun(f.project, command, f.options)).rejects.toMatchObject({ code: 'MODEL_INVOCATION_REASONING_UNSUPPORTED' });
    expect(f.posts).toBe(0); expect(f.counterBodies).toHaveLength(0); expect(stored(f)).toEqual({ runs: 0, proposals: 0 });
  });
  it.each([['', 'length', 'BRAIN_OUTPUT_TRUNCATED'], ['   ', 'length', 'BRAIN_OUTPUT_TRUNCATED'], ['', 'stop', 'BRAIN_OUTPUT_INVALID']] as const)(
    'stages empty content %j at %s and never resends failed replay', async (response, finishReason, code) => {
      const f = await fixture({ response, finishReason, maxOutputTokens: 64 });
      await configure(f, { maxCompletionTokens: 64 });
      for (let i = 0; i < 2; i++) {
        const error = await planRun(f.project, command, f.options).catch(error => error);
        expect(error).toMatchObject({ code, params: code === 'BRAIN_OUTPUT_TRUNCATED' ? { maxCompletionTokens: 64 } : { stage: 'content' } });
        if (code === 'BRAIN_OUTPUT_TRUNCATED') for (const locale of ['en', 'tr'] as const) {
          expect(error.localize(locale).message).toContain('brain_planner.maxCompletionTokens');
          expect(error.localize(locale).message).toContain('brain_planner.reasoning=off');
        }
      }
      expect(f.posts).toBe(1); expect(stored(f)).toEqual({ runs: 0, proposals: 0 });
    });
  it('rejects a planner cap that no longer fits the served window before model POST', async () => {
    const f = await fixture({ maxOutputTokens: 64, tokenCount: { count: 950, max_model_len: 1000 } });
    await configure(f, { maxCompletionTokens: 64 });
    await expect(planRun(f.project, command, f.options)).rejects.toMatchObject({ code: 'BRAIN_CONTEXT_TOO_LARGE', params: { observed: 1014, limit: 1000, unit: 'tokens' } });
    expect(f.posts).toBe(0); expect(stored(f)).toEqual({ runs: 0, proposals: 0 });
  });
  it('keeps non-empty length output on the normal proposal validation path', async () => {
    const f = await fixture({ finishReason: 'length' });
    expect((await planRun(f.project, command, f.options)).proposal.status).toBe('pending');
    expect(f.posts).toBe(1); expect(stored(f)).toEqual({ runs: 0, proposals: 1 });
  });
  it('keeps the profile maximum binding instead of silently shrinking the requested planner cap', async () => {
    const f = await fixture(); await configure(f, { maxCompletionTokens: 64 });
    await expect(planRun(f.project, command, f.options)).rejects.toMatchObject({ code: 'OPENAI_CHAT_REQUEST_INVALID' });
    expect(f.posts).toBe(0); expect(stored(f)).toEqual({ runs: 0, proposals: 0 });
  });
  it('refuses spending for a larger planner cap before model POST or proposal', async () => {
    const f = await fixture({ maxOutputTokens: 40000, budget: 20 });
    await configure(f, { maxCompletionTokens: 40000 });
    await expect(planRun(f.project, command, f.options)).rejects.toMatchObject({ code: 'PROVIDER_SPEND_EXHAUSTED' });
    expect(f.posts).toBe(0); expect(stored(f)).toEqual({ runs: 0, proposals: 0 });
  });
  it('retains the same profile delivery findings when the planner budget and thinking choice change', async () => {
    const f = await fixture({ thinking: 'supported', maxOutputTokens: 64, responseMaxBytes: 1048576 });
    const before = await assessConfiguredModelInvocationDelivery(f.project, f.options);
    expect(before.map(row => row.surface)).toEqual(['runtime-service', 'mcp']);
    await configure(f, { maxCompletionTokens: 64, reasoning: 'off' });
    expect(await assessConfiguredModelInvocationDelivery(f.project, f.options)).toEqual(before);
    expect(f.posts).toBe(0); expect(stored(f)).toEqual({ runs: 0, proposals: 0 });
  });
});
