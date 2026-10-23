import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { assertNativeWorkerBinding, compileNativeCodingDockerProfile, createClientModelReport, createCodexState, createNormalizerState, flushUnmapped, normalizeCodexLine,
  readCodexRolloutModel, resolveDockerTaskProfile } from '#adapters/index.js';
import { catalogPinModelEvidence, parseProviderCatalogDocument, type CatalogModel } from '#domain/index.js';

/** Real Codex 0.163.0 rollout (probe 2026-10-23, trimmed and redacted): `session_meta.cli_version` 0.163.0, one `turn_context.model` gpt-6-luna. */
const rolloutFixture = new URL('../../fixtures/native-codex/rollout-0.163.0.jsonl', import.meta.url);
const threadId = '00000000-0000-4000-8000-000000000001';
const limits = { pollMs: 5, waitMs: 2_000, maxFileBytes: 65_536, maxLineBytes: 8_192, maxEntries: 64 };
const cleanups: string[] = [];
afterEach(async () => { for (const path of cleanups.splice(0)) await rm(path, { recursive: true, force: true }); });
async function home() {
  const root = await mkdtemp(join(tmpdir(), 'dn-codex-')); cleanups.push(root);
  const day = join(root, 'sessions', '2026', '10', '23'); await mkdir(day, { recursive: true });
  return { root, sessions: join(root, 'sessions'), file: join(day, `rollout-2026-10-23T04-17-57-${threadId}.jsonl`) };
}
const fixture = async () => readFile(rolloutFixture, 'utf8');
const turnContext = (model: string) => JSON.stringify({ timestamp: '2026-10-23T01:17:59.172Z', type: 'turn_context', payload: { model, cwd: '/workspace' } });

describe('reading the client-resolved model from the Codex session log (owner Q4 2026-10-23)', () => {
  it('ships its bounds as registry limits data', async () => {
    // Read as data: the provider catalog is package-private to the native-connection unit.
    const catalog = JSON.parse(await readFile(new URL('../../../src/adapters/core/native-connection/internal/providers.json', import.meta.url), 'utf8')) as { limits: { clientModelReport: typeof limits } };
    expect(catalog.limits.clientModelReport).toEqual({ pollMs: expect.any(Number), waitMs: expect.any(Number), maxFileBytes: expect.any(Number), maxLineBytes: expect.any(Number), maxEntries: expect.any(Number) });
    // The real 0.163.0 log carried a 91 KB world_state line and the turn context at about 150 KB: the bounds must cover that shape.
    expect(catalog.limits.clientModelReport.maxFileBytes).toBeGreaterThanOrEqual(1_048_576);
    expect(catalog.limits.clientModelReport.maxLineBytes).toBeGreaterThanOrEqual(131_072);
  });
  it('reads only the model and the client version of the real 0.163.0 log', async () => {
    const paths = await home(); await writeFile(paths.file, await fixture());
    expect(await readCodexRolloutModel(paths.sessions, threadId, limits)).toEqual({ status: 'found', model: 'gpt-6-luna', cliVersion: '0.163.0', contexts: 1 });
  });
  it('is absent without a log for this thread, and refuses a thread id that is not a session id', async () => {
    const paths = await home();
    expect(await readCodexRolloutModel(paths.sessions, threadId, limits)).toEqual({ status: 'absent' });
    await writeFile(join(paths.sessions, '2026', '10', '23', 'rollout-2026-10-23T04-17-57-00000000-0000-4000-8000-000000000002.jsonl'), await fixture());
    expect(await readCodexRolloutModel(paths.sessions, threadId, limits)).toEqual({ status: 'absent' });
    expect(await readCodexRolloutModel(join(paths.root, 'missing'), threadId, limits)).toEqual({ status: 'absent' });
    for (const id of ['../../etc/passwd', '*', '', threadId.replace(/0/g, 'A'), `${threadId}/..`]) expect(await readCodexRolloutModel(paths.sessions, id, limits)).toEqual({ status: 'invalid' });
  });
  it('never follows a symbolic link: the log file, a date folder or the sessions folder', async () => {
    const paths = await home(), real = join(paths.root, 'real.jsonl'); await writeFile(real, await fixture());
    await symlink(real, paths.file);
    expect(await readCodexRolloutModel(paths.sessions, threadId, limits)).toEqual({ status: 'unsafe' });
    const other = await home(), elsewhere = join(other.root, 'elsewhere'); await mkdir(elsewhere);
    await writeFile(join(elsewhere, `rollout-x-${threadId}.jsonl`), await fixture());
    await symlink(elsewhere, join(other.sessions, '2026', '10', '24'));
    expect(await readCodexRolloutModel(other.sessions, threadId, limits)).toEqual({ status: 'absent' });
    const linked = join(other.root, 'linked-sessions'); await symlink(other.sessions, linked);
    expect(await readCodexRolloutModel(linked, threadId, limits)).toEqual({ status: 'unsafe' });
  });
  it('skips an over-long line, refuses a log whose turn context lies beyond the byte cap, and bounds the folder walk', async () => {
    const paths = await home(), text = await fixture();
    await writeFile(paths.file, JSON.stringify({ type: 'world_state', payload: { state: 'x'.repeat(limits.maxLineBytes) } }) + '\n' + text);
    expect(await readCodexRolloutModel(paths.sessions, threadId, limits)).toMatchObject({ status: 'found', model: 'gpt-6-luna' });
    await writeFile(paths.file, ('{"type":"event_msg","payload":{}}\n').repeat(Math.ceil(limits.maxFileBytes / 33) + 1) + text);
    expect(await readCodexRolloutModel(paths.sessions, threadId, limits)).toEqual({ status: 'oversized' });
    const crowded = await home();
    for (let index = 0; index < limits.maxEntries + 1; index++) await mkdir(join(crowded.sessions, '2026', `m${index}`));
    expect(await readCodexRolloutModel(crowded.sessions, threadId, limits)).toEqual({ status: 'oversized' });
  });
  it('keeps the first turn context and counts the others; a partial last line is not read', async () => {
    const paths = await home();
    await writeFile(paths.file, (await fixture()) + turnContext('gpt-6-astra') + '\n' + turnContext('gpt-6-sol'));
    expect(await readCodexRolloutModel(paths.sessions, threadId, limits)).toEqual({ status: 'found', model: 'gpt-6-luna', cliVersion: '0.163.0', contexts: 2 });
    await writeFile(paths.file, '{"type":"turn_context","payload":{"model":7}}\n');
    expect(await readCodexRolloutModel(paths.sessions, threadId, limits)).toEqual({ status: 'invalid' });
  });
});

describe('the bootstrap emits exactly one client-reported session start', () => {
  const run = async (clientHome: string, prepare: (codex: ReturnType<typeof createCodexState>) => Promise<void>, overrides: Partial<typeof limits> = {}) => {
    const state = createNormalizerState([], Date.now()), codex = createCodexState(), pushed: Record<string, unknown>[] = [];
    const report = createClientModelReport('codex-exec-json', 'codex', clientHome, { ...limits, ...overrides }, state, codex, events => pushed.push(...events));
    await prepare(codex);
    await report.finish();
    return [...pushed, ...flushUnmapped(state)];
  };
  const started = (model: string | null, cliVersion: string | null) => ({ schemaVersion: 1, sequence: expect.any(Number), atMs: expect.any(Number), kind: 'session.started', provider: 'codex', model, cliVersion });
  const thread = (codex: ReturnType<typeof createCodexState>) => normalizeCodexLine(JSON.stringify({ type: 'thread.started', thread_id: threadId }), createNormalizerState([], 0), codex);
  it('reads a log that appears late, while the worker runs, and leaves only the model and client version', async () => {
    const paths = await home();
    const events = await run(paths.root, async codex => {
      thread(codex);
      await new Promise(resolve => setTimeout(resolve, 30));
      await writeFile(paths.file, await fixture());
      await new Promise(resolve => setTimeout(resolve, 60));
    });
    expect(events).toEqual([started('gpt-6-luna', '0.163.0')]);
  });
  it('emits a start without a model, and says why, when the log never appears or no thread was announced', async () => {
    const paths = await home();
    expect(await run(paths.root, async codex => { thread(codex); }, { waitMs: 20 })).toEqual([started(null, null), expect.objectContaining({ kind: 'unmapped', nativeType: 'codex-rollout:absent', count: 1 })]);
    expect(await run(paths.root, async () => undefined)).toEqual([started(null, null), expect.objectContaining({ kind: 'unmapped', nativeType: 'codex-rollout:thread', count: 1 })]);
    const unsupported = createNormalizerState([], 0), pushed: Record<string, unknown>[] = [];
    await createClientModelReport('cursor-agent-stream-json', 'cursor', paths.root, limits, unsupported, createCodexState(), events => pushed.push(...events)).finish();
    expect([...pushed, ...flushUnmapped(unsupported)]).toEqual([expect.objectContaining({ kind: 'session.started', model: null }), expect.objectContaining({ nativeType: 'client-model-report:unsupported' })]);
  });
  it('counts a second turn context unmapped instead of a second session start', async () => {
    const paths = await home();
    const events = await run(paths.root, async codex => {
      await writeFile(paths.file, await fixture()); thread(codex);
      await new Promise(resolve => setTimeout(resolve, 40));
      await writeFile(paths.file, (await fixture()) + turnContext('gpt-6-astra') + '\n');
    });
    expect(events).toEqual([started('gpt-6-luna', '0.163.0'), expect.objectContaining({ kind: 'unmapped', nativeType: 'codex-rollout:turn_context', count: 1 })]);
  });
  it('emits a start without a model for an oversized log', async () => {
    const paths = await home();
    await writeFile(paths.file, ('{"type":"event_msg","payload":{}}\n').repeat(Math.ceil(limits.maxFileBytes / 33) + 1) + await fixture());
    expect(await run(paths.root, async codex => { thread(codex); }, { waitMs: 20 })).toEqual([started(null, null), expect.objectContaining({ nativeType: 'codex-rollout:oversized' })]);
  });
});

describe('switch impact: Codex profiles stamped before the capability (binding.ts)', () => {
  const template = () => ({ id: 'coding', version: 1, adapter: { id: 'docker', version: 2 }, parameters: {
    argv: ['unused'], imageId: 'sha256:' + 'a'.repeat(64), memoryBytes: 268435456, pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2,
    tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 } });
  const invocation = { schemaVersion: 4, provider: 'codex', cliVersion: 'codex-cli 0.163.0', discovery: { schemaVersion: 1, mode: 'repository' }, permissionMode: 'unattended',
    model: { channelId: 'codex-cli-subscription', modelId: 'gpt-6-luna', auxiliaryModelIds: [] }, prompt: 'Edit note.txt.' };
  it('stamps new Codex profiles client-reported and refuses a profile stamped none (re-create Codex profiles at the switch)', () => {
    const profile = compileNativeCodingDockerProfile(template(), invocation);
    expect(resolveDockerTaskProfile(profile).nativeSubscription).toMatchObject({ modelUsageEvidence: 'client-reported' });
    expect(() => assertNativeWorkerBinding(profile)).not.toThrow();
    const stamped = { ...profile, parameters: { ...profile.parameters, nativeSubscription: { ...(profile.parameters.nativeSubscription as object), modelUsageEvidence: 'none' } } };
    expect(() => assertNativeWorkerBinding(stamped)).toThrow('WORKER_MODEL_BINDING_MISMATCH');
  });
});

describe('packaged Codex catalog records the client-reported names', () => {
  it('records each model under its exact id as the turn_context.model name, so a frozen pin carries its own and the other names', async () => {
    const raw = JSON.parse(await readFile(new URL('../../../assets/model-catalog/codex-cli-subscription.json', import.meta.url), 'utf8'));
    const models = parseProviderCatalogDocument(raw).providers[0]!.models as readonly CatalogModel[];
    for (const model of models) expect('reportedNames' in model && model.reportedNames).toEqual([{ name: model.nativeId, cliVersion: '0.163.0',
      source: 'codex rollout turn_context.model', observedAt: '2026-10-23' }]);
    const evidence = catalogPinModelEvidence(models, 'gpt-6-luna');
    expect(evidence.reportedNames).toEqual(['gpt-6-luna']);
    expect(evidence.otherReportedNames).toHaveLength(models.length - 1);
    expect(raw.revision).toBe('codex-cli-subscription-2026-10-23');
  });
});
