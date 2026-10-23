// S3-4: the Brain plans through the subscription CLI step, resolved like any model (catalog, profile, activation, S2 role gate, invocation
// application), with a scripted fake CLI: no real CLI and no model call. The fake replays the HEADLESS-0 line shapes for the fixture model id.
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planRun } from '../../../src/index.js';
import { clearConfigCache } from '#platform/index.js';
import { proposalFixture } from '../support/run-proposal.js';
import { brainProviderFixture } from '../support/brain-provider.js';
import { assistantLine, initLine, rateLimitLine, resultLine, uiLine, writeFakeCli, type FakeStep } from '../../fixtures/native-headless/stream.js';

const MODEL = 'vendor/model', cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
const command = { schemaVersion: 1 as const, scopeId: 's', commandId: 'plan-headless', intent: 'Plan a durable customer purchase' };
const { graph, budgetCeiling, requiredPermissions } = proposalFixture('business'), draft = JSON.stringify({ graph, budgetCeiling, requiredPermissions });
const lines = (text: string, result: Record<string, unknown> = {}, init: Record<string, unknown> = {}, rate = rateLimitLine()): FakeStep[] =>
  [uiLine(), initLine({ model: MODEL, ...init }), assistantLine(text, MODEL), rate, resultLine(text, result, MODEL)].map(line => ({ line }));
type Logged = { mode: string; argv: string[] };
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(steps: FakeStep[]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'deckent-brain-headless-'))); roots.push(root);
  const bin = join(root, 'bin'), configDir = join(root, 'login'), logPath = join(root, 'cli.jsonl');
  await mkdir(bin); await mkdir(configDir, { mode: 0o700 });
  const executable = await writeFakeCli(bin, { logPath, steps, initCwd: 'actual' });
  const f = await brainProviderFixture({ noCharge: true, headless: { executable, configDir, stateDir: join(root, 'state') } }); cleanups.push(f.close);
  const log = async () => existsSync(logPath) ? (await readFile(logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Logged) : [];
  return { f, calls: async () => (await log()).filter(entry => entry.mode === 'call') };
}

describe.skipIf(process.platform !== 'linux')('S3-4 Brain through the headless subscription step (fake CLI)', () => {
  it('plans one guarded turn: subscription contribution, no money, no prompt in argv, no effort flag (reasoning model-default and off)', async () => {
    const h = await fixture(lines(draft));
    const result = await planRun(h.f.project, command, h.f.options);
    const source = result.proposal.proposal.source;
    expect(source).toMatchObject({ kind: 'model', contribution: { billingAxis: 'subscription' } });
    const [call] = await h.calls();
    expect(call!.argv).toEqual(expect.arrayContaining(['--model', MODEL, '--max-turns', '1']));
    expect(call!.argv).not.toContain('--effort');
    expect(JSON.stringify(call!.argv)).not.toContain('durable customer purchase');
    // Brain `reasoning: off` on a CLI binding: the CLI has no thinking switch, so the request simply carries no effort (never a refusal).
    await writeFile(join(h.f.project, '.deckent/config.json'), JSON.stringify({ ...h.f.config, brain_planner: { reasoning: 'off' } })); clearConfigCache();
    await expect(planRun(h.f.project, { ...command, commandId: 'plan-off' }, h.f.options)).resolves.toMatchObject({ proposal: { proposal: { source: { kind: 'model' } } } });
    expect((await h.calls()).at(-1)!.argv).not.toContain('--effort');
  });
  it('N15: JSON cut at the output limit is truncated, not invalid', async () => {
    const h = await fixture(lines(draft.slice(0, 40), { stop_reason: 'max_tokens' }));
    await expect(planRun(h.f.project, command, h.f.options)).rejects.toMatchObject({ code: 'BRAIN_OUTPUT_TRUNCATED' });
  });
  it.each([
    ['N13 a rejected rate limit', lines('', { is_error: true, subtype: 'error_during_execution', api_error_status: 429 }, {}, rateLimitLine('rejected')), 'HEADLESS_QUOTA_EXHAUSTED', { resetsAtMs: 1792773600000 }],
    ['N13 credits required', lines('', {}, {}, rateLimitLine('rejected', { errorCode: 'credits_required' })), 'HEADLESS_CREDITS_REQUIRED', undefined],
    ['a login failure inside the run', lines('', { is_error: true, subtype: 'error_during_execution', api_error_status: 401 }), 'HEADLESS_LOGIN_REQUIRED', undefined],
    ['N2 an API key source', lines(draft, {}, { apiKeySource: 'ANTHROPIC_API_KEY' }), 'HEADLESS_GUARD_FAILED', { field: 'apiKeySource' }],
    ['N4 another model in the result', [uiLine(), initLine({ model: MODEL }), resultLine(draft, {}, 'other-model')].map(line => ({ line })), 'HEADLESS_GUARD_FAILED', { field: 'modelUsage' }],
    ['N14 the turn limit', lines('', { is_error: true, subtype: 'error_max_turns' }), 'BRAIN_OUTPUT_INVALID', { stage: 'error_max_turns' }],
  ] as const)('names %s typed, sends once and never retries', async (_label, steps, code, params) => {
    const h = await fixture([...steps]);
    for (let attempt = 0; attempt < 2; attempt++) await expect(planRun(h.f.project, command, h.f.options)).rejects.toMatchObject({ code, ...(params ? { params } : {}) });
    expect(await h.calls()).toHaveLength(1);
  });
});
