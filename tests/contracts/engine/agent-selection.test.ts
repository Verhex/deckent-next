import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { openSqliteAgentCatalogStore, bindNativeWorkerEffort, compileNativeCodingWorkInput, isNativeCodingTemplate, nativeCodingRefusalCode, nativeWorkerEffortCapability,
  NATIVE_PROMPT_LIMITS } from '#adapters/index.js';
import { AgentCatalogApplication, assertRunExecution, composeModelRolePolicy, personaDigest, renderRunCreateApprovalSummary, resolveWorkerEffortExecution, selectTaskAgents, skillContentDigest,
  skillSetDigest, type AgentCatalogDependencies, type ModelCatalogReader } from '#engine/index.js';
import { parseProviderCatalogDocument, readWorkerModelPin, type ExecutionProfileDefinition, type ModelCatalogModelRecord } from '#domain/index.js';
import { createHmacIntegrity } from '#platform/index.js';
import { seedCatalog, SEED_CHANNEL } from '../support/model-catalog.js';
import { moved, tamperSkillRevision, writeStanding } from '../support/agent-standing.js';

// S8-1b (S8-DESIGN §5; owner Q-S1 "the system selects the agent"): for each work-input task the system — never the Brain or a model — picks at most
// one agent of the scope by WorkClass binding and standing (the single `active` agent, else candidates by agent id), re-digests its pinned persona
// and skills from the exact revisions, fills the native prompt's persona/skill parts and seals the choice in the frozen task. No model id is read
// or written by the selection; no eligible agent leaves the task exactly as before (core prompt only).
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const };
const integrity = createHmacIntegrity('catalog-key', randomBytes(32));
const human = { id: 'h', issuer: 'local-os', subject: 'uid:1000', assurance: 'os-user' as const, scopeIds: ['s', 'other'] };
const docker = { imageId: 'sha256:' + 'a'.repeat(64), memoryBytes: 268435456, pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216,
  deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 };
const claude = (composition?: object) => ({ provider: 'claude', cliVersion: '2.1.293 (Claude Code)', discovery: { schemaVersion: 1, mode: 'repository' }, permissionMode: 'unattended',
  ...(composition ? { composition } : {}) });
const registry = (composition?: object) => ({ schemaVersion: 1, revision: 'r1', profiles: [{ id: 'claude-t', version: 1, adapter: { id: 'native-coding-template', version: 1 },
  parameters: { schemaVersion: 1, docker, invocation: claude(composition) } }], kinds: [{ kind: 'coding', profile: { id: 'claude-t', version: 1 } }, { kind: 'plain', profile: { id: 'claude-t', version: 1 } }],
  evaluators: [{ id: 'process-exit', version: 1, implementation: { id: 'process-exit', version: 1 } }] });
const workInput = (task = 'Append done to note.txt') => ({ schemaVersion: 2, task, scope: { paths: ['note.txt'] }, acceptance: 'note.txt ends with done' });
const graph = (task?: string) => ({ schemaVersion: 4, revision: 1, tasks: [{ id: 't', kind: 'coding', dependencies: [], acceptanceCriteria: ['exit'], workInput: workInput(task) }],
  criterionDefinitions: [{ id: 'exit', version: 1, description: 'Zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] });
const validation = { profile() { return undefined; }, criterion() { return undefined; }, isTemplate: isNativeCodingTemplate };
const compiler = { capability: nativeWorkerEffortCapability, bind: bindNativeWorkerEffort,
  compile: (value: ExecutionProfileDefinition, work: unknown, effort?: Parameters<typeof compileNativeCodingWorkInput>[2], evidence?: Parameters<typeof compileNativeCodingWorkInput>[3],
    task?: { readonly agent?: Parameters<typeof compileNativeCodingWorkInput>[5] }) => compileNativeCodingWorkInput(value, work, effort, evidence, [], task?.agent) };
async function reader(): Promise<ModelCatalogReader> {
  const document = parseProviderCatalogDocument(await seedCatalog()), provider = document.providers[0]!;
  const models: ModelCatalogModelRecord[] = provider.models.map(model => ({ schemaVersion: 1, channelId: SEED_CHANNEL, modelId: model.nativeId, revision: 7, providerVersion: provider.version, model, catalogRevision: document.revision }));
  const channel = { schemaVersion: 1 as const, channelId: SEED_CHANNEL, revision: 3, providerVersion: provider.version, channel: provider.channel, catalogRevision: document.revision };
  return { async channels() { return [channel]; }, async channel(id) { return id === SEED_CHANNEL ? channel : null; }, async models(id) { return id === SEED_CHANNEL ? models : []; },
    async activation(scopeId, channelId, modelId) { return { schemaVersion: 1, scopeId, channelId, modelId, revision: 5, state: 'active' }; }, close() {} };
}
async function fixture(extra: Partial<AgentCatalogDependencies> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dn-agent-select-')); roots.push(root);
  const path = join(root, 'ledger.db'); openSqliteLedger(path, options).close();
  let ids = 0;
  const app = new AgentCatalogApplication({ verifier: { verify: async () => human }, authorize: async () => ({ revision: 'p', ruleId: 'r' }),
    openStore: async access => openSqliteAgentCatalogStore(path, options, integrity, access), now: () => 1_000, eventId: () => `e${++ids}`,
    promptCompositionMaxBytes: NATIVE_PROMPT_LIMITS.compositionMaxBytes, ...extra });
  const skill = async (skillId: string, text = 'Siparişi faturayla eşle.') => (await app.defineSkill({ schemaVersion: 1, scopeId: 's', commandId: `k-${skillId}`, skillId, expectedRevision: null,
    content: { name: skillId, text } })).item;
  const agent = async (agentId: string, skills: readonly { skillId: string; revision: number; contentDigest: string }[] = [], workClasses = ['feature'], persona = `${agentId} persona: önce testi yaz.`) =>
    (await app.defineAgent({ schemaVersion: 1, scopeId: 's', commandId: `a-${agentId}`, agentId, expectedRevision: null,
      content: { name: agentId, persona, workClasses, skills: skills.map(row => ({ skillId: row.skillId, revision: row.revision, digest: row.contentDigest })), parentAgentId: null } })).item;
  const select = async (scopeId = 's', input = graph()) => { const store = await openSqliteAgentCatalogStore(path, options, integrity, 'read');
    try { return await selectTaskAgents(input, undefined, scopeId, store); } finally { store.close(); } };
  const admit = async (input = graph(), composition?: object) => { const agents = await select('s', input);
    return resolveWorkerEffortExecution(input, registry(composition), await reader(), validation, compiler, { scopeId: 's', nowMs: Date.parse('2026-10-23T12:00:00Z'), roles: composeModelRolePolicy(undefined), agents }); };
  const standings = async (agentId: string, revision = 1) => { const store = await openSqliteAgentCatalogStore(path, options, integrity, 'read');
    try { return await store.standings('s', agentId, revision); } finally { store.close(); } };
  return { path, app, skill, agent, select, admit, standings };
}
/** The compiled native prompt: its sealed segments (kind, id, version) and the rendered text after the core part. */
const prompt = (profile: ExecutionProfileDefinition) => { const delivery = (profile.parameters as { nativeSubscription: { promptDelivery: { task: string; segments: { kind: string; id: string; version: number }[] } } }).nativeSubscription.promptDelivery;
  return { text: delivery.task, persona: delivery.segments.filter(row => row.kind === 'persona').map(({ id, version }) => ({ id, version })), skills: delivery.segments.filter(row => row.kind === 'skill').map(({ id, version }) => ({ id, version })) }; };

describe('S8-1a: definition opens the standing rows and bounds the prompt', () => {
  it('a defined agent has a candidate standing per bound WorkClass; inspect shows them', async () => {
    const f = await fixture(); await f.agent('auditor', [], ['feature', 'docs']);
    expect((await f.standings('auditor')).map(row => [row.workClass, row.standing, row.standingRevision])).toEqual([['docs', 'candidate', 1], ['feature', 'candidate', 1]]);
    const view = await f.app.inspectAgent({ schemaVersion: 1, scopeId: 's', agentId: 'auditor' });
    expect(view.status === 'ok' && view.standings.map(row => row.standing)).toEqual(['candidate', 'candidate']);
  });
  it('N16 (define time): persona + pinned skills over the composition bound minus the reserved task budget is AGENT_PROMPT_TOO_LARGE; nothing is written', async () => {
    const f = await fixture({ promptCompositionMaxBytes: 12_000 }), k = await f.skill('big', 'x'.repeat(4000));
    await expect(f.agent('too-big', [k], ['feature'], 'p'.repeat(4000))).rejects.toMatchObject({ code: 'AGENT_PROMPT_TOO_LARGE' });
    expect((await f.app.inspectAgent({ schemaVersion: 1, scopeId: 's', agentId: 'too-big' })).status).toBe('not-found');
    expect(await f.standings('too-big')).toEqual([]);
  });
});

describe('S8-1b: system agent selection, prompt parts and the frozen seal', () => {
  it('N25: a scope with no agent selects nothing and the frozen task is byte-identical to a Run without agents', async () => {
    const f = await fixture();
    expect((await f.select()).size).toBe(0);
    const execution = await f.admit();
    expect(execution.tasks[0]).not.toHaveProperty('agent');
    expect(prompt(execution.tasks[0]!.profile)).toMatchObject({ persona: [], skills: [] });
  });
  it('a candidate agent of the WorkClass is chosen, its persona and pinned skills become the persona/skill parts, and the seal carries digests and pins', async () => {
    const f = await fixture(), k = await f.skill('tdd', 'Önce başarısız testi yaz.'), a = await f.agent('auditor', [k]);
    const execution = await f.admit(), task = execution.tasks[0]!;
    expect(task.agent).toEqual({ schemaVersion: 1, agentId: 'auditor', revision: 1, workClass: 'feature', personaDigest: personaDigest(a.content.persona), skillSetDigest: a.skillSetDigest,
      skills: [{ skillId: 'tdd', revision: 1, digest: skillContentDigest({ name: 'tdd', text: 'Önce başarısız testi yaz.' }) }], standing: 'candidate', standingRevision: 1,
      selection: { eligible: 1, position: 0, reason: 'first-candidate' } });
    expect(a.skillSetDigest).toBe(skillSetDigest(task.agent!.skills));
    expect(prompt(task.profile)).toMatchObject({ persona: [{ id: 'auditor', version: 1 }], skills: [{ id: 'tdd', version: 1 }] });
    expect(prompt(task.profile).text).toContain(a.content.persona); expect(prompt(task.profile).text).toContain('Önce başarısız testi yaz.');
    // Model independence: the worker was assigned from the WorkClass list exactly as without an agent; the seal names no model.
    expect(readWorkerModelPin(task.profile.parameters)!.pin.modelId).toBe(task.assignment!.modelId);
    expect(JSON.stringify(task.agent)).not.toContain(task.assignment!.modelId);
    expect(assertRunExecution(graph(), execution).tasks[0]!.agent).toEqual(task.agent);
  });
  it('the single active agent wins over candidates; with none active the first candidate by agent id; the card names the agent and its standing', async () => {
    const f = await fixture(); await f.agent('b-second'); await f.agent('a-first');
    expect((await f.select()).get('t')!.seal).toMatchObject({ agentId: 'a-first', selection: { eligible: 2, position: 0, reason: 'first-candidate' } });
    writeStanding(f.path, integrity, moved((await f.standings('b-second'))[0]!, 'active'));
    const chosen = (await f.select()).get('t')!.seal;
    expect(chosen).toMatchObject({ agentId: 'b-second', standing: 'active', standingRevision: 2, selection: { eligible: 2, position: 1, reason: 'active-agent' } });
    const execution = await f.admit(), card = renderRunCreateApprovalSummary({ schemaVersion: 1, commandId: 'c', scopeId: 's', runId: 'r', graph: graph() },
      { graph: graph(), execution } as never, { decision: 'require-approval', revision: 'p', reason: 'APPROVAL_REQUIRED' }, 'tr');
    expect(card).toContain('ajan: b-second (sürüm 1, terfili)');
  });
  it('negative: two active agents of one WorkClass in a scope is a corrupt catalog, never a silent choice', async () => {
    const f = await fixture(); await f.agent('one'); await f.agent('two');
    for (const id of ['one', 'two']) writeStanding(f.path, integrity, moved((await f.standings(id))[0]!, 'active'));
    await expect(f.select()).rejects.toMatchObject({ code: 'AGENT_CATALOG_CORRUPT' });
  });
  it('N15: a retired or redesign-required agent is never selected; an agent of another WorkClass or scope is never selected', async () => {
    const f = await fixture(); await f.agent('retired'); await f.agent('narrowed'); await f.agent('docs-only', [], ['docs']);
    writeStanding(f.path, integrity, moved((await f.standings('retired'))[0]!, 'retired'));
    writeStanding(f.path, integrity, moved((await f.standings('narrowed'))[0]!, 'redesign-required'));
    expect((await f.select()).size).toBe(0);
    expect((await f.select('other')).size).toBe(0);
  });
  it('N14: a new agent revision is a new key — the old revision\'s standing is not read; the new one starts candidate', async () => {
    const f = await fixture(), first = await f.agent('auditor');
    writeStanding(f.path, integrity, moved((await f.standings('auditor'))[0]!, 'active'));
    await f.app.defineAgent({ schemaVersion: 1, scopeId: 's', commandId: 'a-auditor-2', agentId: 'auditor', expectedRevision: 1, content: { ...first.content, workClasses: ['feature', 'docs'] } });
    const rows = await f.standings('auditor', 2);
    // A person-authored revision inherits `active` for the WorkClass both revisions bind (Q-S6); the newly bound one starts candidate.
    expect(rows.map(row => [row.workClass, row.standing, row.basis.kind])).toEqual([['docs', 'candidate', 'definition'], ['feature', 'active', 'inherited']]);
    expect((await f.standings('auditor', 1))[0]).toMatchObject({ standing: 'active', standingRevision: 2 });
    expect((await f.select()).get('t')!.seal).toMatchObject({ revision: 2, standing: 'active' });
  });
  it('N17: a pinned skill whose stored text no longer matches its pin is AGENT_CATALOG_CORRUPT at admission; no Run is prepared', async () => {
    const f = await fixture(), k = await f.skill('tdd'); await f.agent('auditor', [k]);
    tamperSkillRevision(f.path, integrity, 'tdd', 1, 'Testleri atla.');
    await expect(f.select()).rejects.toMatchObject({ code: 'AGENT_CATALOG_CORRUPT' });
  });
  it('N16 (admission): a composition that fits without the agent but not with it is AGENT_PROMPT_TOO_LARGE, never a skip to another agent or none', async () => {
    const f = await fixture(), k = await f.skill('wide', 'y'.repeat(9000)); await f.agent('auditor', [k], ['feature'], 'p'.repeat(9000));
    const error = await f.admit(graph('t'.repeat(15_000))).catch((value: unknown) => value);
    expect(nativeCodingRefusalCode(error)).toBe('AGENT_PROMPT_TOO_LARGE');
  });
  it('the agent persona and skills replace a template\'s own persona/skill parts (the sealed agent is the persona)', async () => {
    const f = await fixture(); await f.agent('auditor');
    const execution = await f.admit(graph(), { persona: { id: 'template-persona', version: 1, text: 'Şablon personası.' }, skills: [{ id: 'template-skill', version: 1, text: 'Şablon becerisi.' }] });
    expect(prompt(execution.tasks[0]!.profile)).toEqual({ text: expect.not.stringContaining('Şablon'), persona: [{ id: 'auditor', version: 1 }], skills: [] });
    const plain = await (await fixture()).admit(graph(), { persona: { id: 'template-persona', version: 1, text: 'Şablon personası.' } });
    expect(prompt(plain.tasks[0]!.profile).persona).toEqual([{ id: 'template-persona', version: 1 }]);
  });
  it('negative: a frozen agent seal whose WorkClass differs from the task\'s is a Run integrity failure', async () => {
    const f = await fixture(); await f.agent('auditor');
    const execution = await f.admit(), task = execution.tasks[0]!;
    expect(() => assertRunExecution(graph(), { ...execution, tasks: [{ ...task, agent: { ...task.agent!, workClass: 'docs' } }] })).toThrow(expect.objectContaining({ code: 'RUN_EXECUTION_INTEGRITY' }));
  });
});
