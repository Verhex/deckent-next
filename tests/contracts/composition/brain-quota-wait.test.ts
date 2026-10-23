// f3 item 1 (owner Q-H4, 2026-10-23): a Brain planning call the subscription refuses for quota waits SHORT and VISIBLY when the reset is within the
// registry bound (`brain_planner.quotaWait`), cancellable, then plans once more under a NEW derived command id whose derivation seals the refused
// call (lineage) — never a retry of the refused call. Beyond the bound, with no known reset, or with no surface that shows the wait: the typed
// refusal (S9 card texts). A scripted fake CLI; no real CLI and no model call.
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectMonitor, planRun } from '../../../src/index.js';
import { inspectConfiguredModelInvocation } from '#composition/core/model-invocation/index.js';
import { brainInvocationCommandId, brainQuotaAttemptCommandId } from '#engine/index.js';
import type { BrainPlanProgress } from '#domain/index.js';
import { clearConfigCache } from '#platform/index.js';
import { proposalFixture } from '../support/run-proposal.js';
import { brainProviderFixture } from '../support/brain-provider.js';
import { assistantLine, initLine, rateLimitLine, resultLine, uiLine, writeFakeCli, type FakeStep } from '../../fixtures/native-headless/stream.js';

const MODEL = 'vendor/model', cleanups: (() => Promise<void>)[] = [], roots: string[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const command = { schemaVersion: 1 as const, scopeId: 's', commandId: 'plan-quota', intent: 'Plan a durable customer purchase' };
const { graph, budgetCeiling, requiredPermissions } = proposalFixture('business'), draft = JSON.stringify({ graph, budgetCeiling, requiredPermissions });
const answer = (): FakeStep[] => [uiLine(), initLine({ model: MODEL }), assistantLine(draft, MODEL), rateLimitLine(), resultLine(draft, {}, MODEL)].map(line => ({ line }));
/** A rejected five-hour window; `resetsAt` in seconds (the CLI's unit), `undefined` = the CLI names no reset. */
const quota = (resetsAt: number | undefined): FakeStep[] => [uiLine(), initLine({ model: MODEL }), assistantLine('', MODEL),
  rateLimitLine('rejected', { resetsAt, unifiedWindows: {} }), resultLine('', { is_error: true, subtype: 'error_during_execution', api_error_status: 429 }, MODEL)].map(line => ({ line }));
const inSeconds = (seconds: number) => Math.ceil(Date.now() / 1000) + seconds;
async function fixture(stepsByCall: FakeStep[][], quotaWait?: Record<string, number>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'deckent-brain-quota-'))); roots.push(root);
  const bin = join(root, 'bin'), configDir = join(root, 'login'), logPath = join(root, 'cli.jsonl');
  await mkdir(bin); await mkdir(configDir, { mode: 0o700 });
  const executable = await writeFakeCli(bin, { logPath, steps: stepsByCall.at(-1)!, stepsByCall, initCwd: 'actual' });
  const f = await brainProviderFixture({ noCharge: true, headless: { executable, configDir, stateDir: join(root, 'state') } }); cleanups.push(f.close);
  if (quotaWait) { await writeFile(join(f.project, '.deckent/config.json'), JSON.stringify({ ...f.config, brain_planner: { quotaWait } })); clearConfigCache(); }
  const calls = async () => existsSync(logPath) ? (await readFile(logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { mode: string }).filter(entry => entry.mode === 'call') : [];
  return { f, calls };
}
const short = { maxWaitMs: 5_000, marginMs: 0, maxAttempts: 2 };
/** The viewer's monitor scope decision (`scope inspect`), the same one its Runs need. */
async function grantMonitor(data: string) {
  const path = join(data, 'policy.json'), policy = JSON.parse(await readFile(path, 'utf8')) as { grants: Record<string, unknown>[] }, run = policy.grants[0]!;
  policy.grants.push({ ...run, id: 'monitor-scope', actions: ['inspect'], resource: { kind: 'scope', ids: ['s'] } });
  await writeFile(path, JSON.stringify(policy), { mode: 0o600 }); clearConfigCache();
}

describe.skipIf(process.platform !== 'linux')('f3 Q-H4 Brain quota: short visible wait, then a new derived attempt', () => {
  it('waits visibly until the reset and plans once more under a derived command id that seals the refused call; a replay sends nothing', async () => {
    const h = await fixture([quota(inSeconds(1)), answer()], short), seen: BrainPlanProgress[] = [];
    const result = await planRun(h.f.project, command, h.f.options, undefined, progress => { seen.push(progress); });
    expect(await h.calls()).toHaveLength(2);
    const wait = seen.find(progress => progress.kind === 'quota-wait');
    expect(wait).toMatchObject({ kind: 'quota-wait', attempt: 2, maxAttempts: 2, after: { commandId: brainInvocationCommandId(command) } });
    expect(seen.map(progress => progress.kind)).toEqual(['quota-wait', 'planning']);
    const source = result.proposal.proposal.source;
    if (source.kind !== 'model' || wait?.kind !== 'quota-wait') throw new Error('model source and a quota wait expected');
    // Not a retry: a new command id derived from the plan command, the attempt number and the refused call's identity.
    expect(source.receipt.commandId).toBe(brainQuotaAttemptCommandId(command, 2, wait.after));
    expect(source.receipt.commandId).not.toBe(brainInvocationCommandId(command));
    expect(wait.untilMs).toBeGreaterThanOrEqual(wait.resetsAtMs);
    // The refused call stays recorded under its own identity.
    const refused = await inspectConfiguredModelInvocation(h.f.project, { schemaVersion: 2, scopeId: 's', invocationId: wait.after.invocationId, reference: source.receipt.reference }, h.f.options);
    expect(refused.invocation).toMatchObject({ request: { commandId: brainInvocationCommandId(command) }, outcome: { state: 'rejected' } });
    const again = await planRun(h.f.project, command, h.f.options, undefined, progress => { seen.push(progress); });
    expect(again.proposal.proposal.proposalId).toBe(result.proposal.proposal.proposalId);
    expect(await h.calls()).toHaveLength(2);
  });
  it('negative: a reset beyond the default bound is the typed refusal at once; nothing waits, one send', async () => {
    const h = await fixture([quota(inSeconds(3600)), answer()]), seen: BrainPlanProgress[] = [];
    await expect(planRun(h.f.project, command, h.f.options, undefined, progress => { seen.push(progress); })).rejects.toMatchObject({ code: 'HEADLESS_QUOTA_EXHAUSTED' });
    expect(seen).toEqual([]); expect(await h.calls()).toHaveLength(1);
  });
  it('negative: the bound is the configured registry value (a 30 s reset over a 1 s bound is refused, nothing waits)', async () => {
    const h = await fixture([quota(inSeconds(30)), answer()], { ...short, maxWaitMs: 1_000 }), seen: BrainPlanProgress[] = [];
    await expect(planRun(h.f.project, command, h.f.options, undefined, progress => { seen.push(progress); })).rejects.toMatchObject({ code: 'HEADLESS_QUOTA_EXHAUSTED' });
    expect(seen).toEqual([]); expect(await h.calls()).toHaveLength(1);
  });
  it('negative: no known reset is the typed refusal; nothing waits', async () => {
    const h = await fixture([quota(undefined), answer()], short), seen: BrainPlanProgress[] = [];
    await expect(planRun(h.f.project, command, h.f.options, undefined, progress => { seen.push(progress); })).rejects.toMatchObject({ code: 'HEADLESS_QUOTA_EXHAUSTED' });
    expect(seen).toEqual([]); expect(await h.calls()).toHaveLength(1);
  });
  it('negative: a caller with no surface to show the wait (no observer) gets the typed refusal at once; the wait is never invisible', async () => {
    const h = await fixture([quota(inSeconds(1)), answer()], short);
    await expect(planRun(h.f.project, command, h.f.options)).rejects.toMatchObject({ code: 'HEADLESS_QUOTA_EXHAUSTED' });
    expect(await h.calls()).toHaveLength(1);
  });
  it('negative: cancelling during the wait ends planning cancelled and nothing is sent after the reset', async () => {
    const h = await fixture([quota(inSeconds(1)), answer()], short), controller = new AbortController();
    await expect(planRun(h.f.project, command, h.f.options, controller.signal, progress => { if (progress.kind === 'quota-wait') controller.abort(); }))
      .rejects.toMatchObject({ code: 'BRAIN_CANCELLED' });
    await new Promise(resolve => setTimeout(resolve, 2_200));
    expect(await h.calls()).toHaveLength(1);
  });
  // f4 item 1: the wait is visible to a surface that did not start it — the standalone monitor and MCP inspect_monitor (the same snapshot) — before any Run.
  it('the standalone monitor shows the active wait before a Run exists; the record is gone once planning resumed', async () => {
    const h = await fixture([quota(inSeconds(3)), answer()], short); await grantMonitor(h.f.data);
    let during: Promise<Awaited<ReturnType<typeof inspectMonitor>>> | undefined;
    await planRun(h.f.project, command, h.f.options, undefined, progress => { if (progress.kind === 'quota-wait') during = inspectMonitor(h.f.project, h.f.options); });
    const install = (await during!).installs[0]!;
    expect(install.brainWaits).toEqual([expect.objectContaining({ scopeId: 's', commandId: 'plan-quota', attempt: 2, maxAttempts: 2,
      after: expect.objectContaining({ commandId: brainInvocationCommandId(command) }) })]);
    expect(JSON.stringify(install.brainWaits)).not.toContain(command.intent);
    const after = (await inspectMonitor(h.f.project, h.f.options)).installs[0]!;
    expect(after.brainWaits).toBeUndefined();
    expect((await readdir(join(h.f.data, 'state', 'brain-waits'))).filter(name => name.endsWith('.json'))).toEqual([]);
  });
  it('negative: cancelling during the wait removes the record; the monitor shows no wait afterwards', async () => {
    const h = await fixture([quota(inSeconds(3)), answer()], short), controller = new AbortController(); await grantMonitor(h.f.data);
    let during: Promise<Awaited<ReturnType<typeof inspectMonitor>>> | undefined;
    await expect(planRun(h.f.project, command, h.f.options, controller.signal, progress => {
      if (progress.kind === 'quota-wait') during = inspectMonitor(h.f.project, h.f.options).finally(() => controller.abort()); })).rejects.toMatchObject({ code: 'BRAIN_CANCELLED' });
    expect((await during!).installs[0]!.brainWaits).toHaveLength(1);
    expect((await inspectMonitor(h.f.project, h.f.options)).installs[0]!.brainWaits).toBeUndefined();
  });
  it('negative: a viewer without the scope decision sees no wait and no scope id, only the hidden count', async () => {
    const h = await fixture([quota(inSeconds(3)), answer()], short);
    let during: Promise<Awaited<ReturnType<typeof inspectMonitor>>> | undefined;
    await planRun(h.f.project, command, h.f.options, undefined, progress => { if (progress.kind === 'quota-wait') during = inspectMonitor(h.f.project, h.f.options); });
    const install = (await during!).installs[0]!;
    expect(install.brainWaits).toBeUndefined(); expect(install.diagnostics).toContain('info:brain-waits-hidden:1');
    expect(JSON.stringify(install)).not.toContain('plan-quota');
  });
  it('negative: refused again after the wait is the typed refusal; the attempt bound allows no second wait (no silent retry)', async () => {
    const h = await fixture([quota(inSeconds(1)), quota(inSeconds(1))], short), seen: BrainPlanProgress[] = [];
    await expect(planRun(h.f.project, command, h.f.options, undefined, progress => { seen.push(progress); })).rejects.toMatchObject({ code: 'HEADLESS_QUOTA_EXHAUSTED' });
    expect(seen.filter(progress => progress.kind === 'quota-wait')).toHaveLength(1);
    expect(await h.calls()).toHaveLength(2);
  });
});
