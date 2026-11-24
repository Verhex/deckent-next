import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeCodingTemplate, compileNativeCodingWorkInput, nativeCliAgent, readLocalOsIdentity, resolveNativeCliWorkerProfile, selectNativePackageProfile, sealedWorkerTreeLocation, withMcpPrincipal } from '#adapters/index.js';
import { openSqliteRunProposalStore, withLocalPrincipalChannel } from '#adapters/index.js';
import { inspectSealedWorkerTree, openSealedNativeInput, reviewSealedWorkerTree, sealWorkerTree } from '#adapters/core/worker-tree-gate/index.js';
import { packageActivity, packageIntentId } from '#engine/core/worker-packages/index.js';
import { approvalRecordSchema, mcpPrincipalRef, type AgentTurnStreamEvent } from '#domain/index.js';
import { DispatchPolicyAuthorization, ENCRYPTED_FILE_SECRET_STORE_ID, FILE_SECRET_STORE_ID, RUNTIME_SERVICE_SCHEMA_VERSION, RunAdmissionApplication, RunCreationAuthority, RunProposalApplication, nativePackageAdmission, verifiedPrincipal, type RunPackageCardCheck } from '#engine/index.js';
import { EMPTY_KNOWN_SECRETS, ErrorRegistry, getConfigKnownSecrets, knownSecretValues, loadConfig, prepareProductDirectory, productResourcePath, resolveGlobalConfigPaths, resolveProductLayout, sha256, SystemTrustedClock, withConfigWriteLock, WORKER_PACKAGE_ALLOWANCE_KEY, type DeckentConfig, type Locale } from '#platform/index.js';
import { nativeAgentFlagSetDigest } from '#adapters/core/native-cli-headless/index.js';
import { codingCommand } from '#surfaces/core/cli-admin/index.js';
import { doCommand, runProposalCommand } from '#surfaces/core/cli-run/index.js';
import { createConfiguredConfigApplication } from '#composition/core/config/index.js';
import { executeConfiguredTask } from '#composition/core/execution/index.js';
import { configuredApproval } from '#composition/core/approvals/index.js';
import { contextPolicySource } from '#composition/core/policy/index.js';
import { composeCore } from '#composition/core/root/index.js';
import { createAgentProposals } from '#composition/core/same-turn-planning/index.js';
import { loadConfiguredScopeContext, withScopeAudit } from '#composition/core/scoped-request/index.js';
import { changeConfiguredPackageAllowance, configuredWorkerPackagePorts, withPackageUse } from '#composition/core/workspace-patch/index.js';
import { inspectConfiguredNativeInputs, produceConfiguredNativeInputs } from '#composition/core/runs/index.js';
// eslint-disable-next-line no-restricted-imports -- The application reuses the real ledger audit and approval integrity custody.
import { withRunCreationAuthority } from '../../../src/composition/core/runs/internal/authority.js';
// eslint-disable-next-line no-restricted-imports -- Use the configured secret command writer without starting a service.
import { executeConfiguredRuntimeSecretOperation } from '../../../src/composition/core/runtime-service/internal/secret.js';
// eslint-disable-next-line no-restricted-imports -- Exercise both production input-floor entries without expanding the composition API.
import { prepareNativeWorkerInputs } from '../../../src/composition/core/execution/internal/worker-inputs.js';

import { openConfiguredAttemptStore } from '../support/configured-open.js';
import { fixtureExecution } from '../support/execution-registry.js';
import { openPtySession } from '../support/pty-session.js';
import { proposalFixture } from '../support/run-proposal.js';

async function removeFixture(path: string) {
  if (!(await lstat(path)).isDirectory()) { await unlink(path); return; }
  await chmod(path, 0o700);
  for (const name of await readdir(path)) await removeFixture(join(path, name));
  await rmdir(path);
}
const roots: string[] = [];
const collision = new AsyncLocalStorage<'writer' | 'use'>();
const hooks = vi.hoisted(() => ({
  failPublication: false, person: undefined as undefined | { id: string; issuer: string; subject: string; assurance: 'os-user' },
  prepared: undefined as unknown, extraKnown: undefined as unknown,
  afterScopeLoad: undefined as undefined | (() => Promise<void>),
  lock: undefined as undefined | ((path: string, phase: 'request' | 'held') => void | Promise<void>),
}));
vi.mock('#platform/index.js', async load => {
  const actual = await load<typeof import('#platform/index.js')>();
  return { ...actual, getConfigKnownSecrets: (config: object) => hooks.extraKnown ?? actual.getConfigKnownSecrets(config),
    async withConfigWriteLock<T>(path: string, work: () => Promise<T>, timeoutMs?: number, options?: Parameters<typeof actual.withConfigWriteLock>[3]) {
      await hooks.lock?.(path, 'request');
      return actual.withConfigWriteLock(path, async () => {
        await hooks.lock?.(path, 'held');
        return work();
      }, timeoutMs, options);
    },
  };
});
vi.mock('#adapters/index.js', async load => {
  const actual = await load<typeof import('#adapters/index.js')>();
  return { ...actual, attestLocalInteractiveTerminal: async () => true, readLocalOsIdentity: () => hooks.person ?? actual.readLocalOsIdentity() };
});
vi.mock('#adapters/core/local-principal/internal/interactive.js', () => ({ attestLocalInteractiveTerminal: async () => true }));
vi.mock('#composition/core/scoped-request/index.js', async load => {
  const actual = await load<typeof import('#composition/core/scoped-request/index.js')>();
  return { ...actual, async loadConfiguredScopeContext(...args: Parameters<typeof actual.loadConfiguredScopeContext>) {
    const context = await actual.loadConfiguredScopeContext(...args);
    const afterLoad = hooks.afterScopeLoad;
    hooks.afterScopeLoad = undefined;
    await afterLoad?.();
    return context;
  } };
});
vi.mock('#adapters/core/setup-detect-coding/index.js', async load => {
  const actual = await load<typeof import('#adapters/core/setup-detect-coding/index.js')>();
  return { ...actual, openPreparedPackageInput: (...args: Parameters<typeof actual.openPreparedPackageInput>) => hooks.prepared ?? actual.openPreparedPackageInput(...args) };
});
vi.mock('../../../src/adapters/core/config-file/internal/documents.js', async load => {
  const actual = await load<typeof import('../../../src/adapters/core/config-file/internal/documents.js')>();
  return { ...actual, createConfigFileDocuments: (...args: Parameters<typeof actual.createConfigFileDocuments>) => {
    const documents = actual.createConfigFileDocuments(...args);
    return { ...documents, publish: (...[input, plan]: Parameters<typeof documents.publish>) => documents.publish(input, async before => {
      const publication = await plan(before);
      if (input.keyPath === 'toolchains.packageAllowances' && hooks.failPublication) throw Error('fixture interruption after stored write intent');
      return publication;
    }) };
  } };
});
afterEach(async () => {
  hooks.person = undefined; hooks.failPublication = false; hooks.extraKnown = undefined; hooks.lock = undefined;
  hooks.prepared = undefined;
  hooks.afterScopeLoad = undefined;
  for (const root of roots.splice(0)) await removeFixture(root);
});

const limits = { allowPatternPaths: [], acknowledgedDenyPaths: [], maxFiles: 100, maxFileBytes: 20_000, maxTotalBytes: 20_000, timeoutMs: 10_000 };
const git = { gitExecutable: '/usr/bin/git', timeoutMs: 10_000, outputBytes: 20_000 };
const file = (value: string) => createHash('sha256').update(value).digest('hex');

async function attemptFixture() {
  const root = await mkdtemp(join(tmpdir(), 'sealed-worker-attempt-')); roots.push(root);
  const checkout = join(root, 'checkout'), source = join(root, 'packages'), workTarget = join(root, 'project');
  for (const directory of [checkout, source, workTarget]) await mkdir(directory, { mode: 0o700 });
  const layout = resolveProductLayout({ projectRoot: workTarget }), artifacts = productResourcePath(layout, 'artifacts');
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  const config = { execution: { secretGate: limits, git } } as DeckentConfig;
  const lockfile = join(checkout, 'package-lock.json'), target = join(checkout, 'node_modules');
  await writeFile(lockfile, '{"lockfileVersion":3}');
  await writeFile(join(source, 'entry.js'), 'export const value = 1;');
  execFileSync(git.gitExecutable, ['init', '-q'], { cwd: checkout, env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  const { digest: listDigest } = await inspectSealedWorkerTree(source, limits);
  const reference = { state: 'sealed' as const, layout: 'node-npm' as const, platform: `${process.platform}-${process.arch}`, project: workTarget,
    workTarget, listDigest, lockfileDigest: file('{"lockfileVersion":3}'), approval: { scopeId: 's', commandId: 'create' } };
  const open = () => openSealedNativeInput(reference, { root: workTarget, workTarget, checkout, scopeId: 's', config, layout });
  const publish = () => sealWorkerTree(source, sealedWorkerTreeLocation(artifacts, reference), 'node_modules', listDigest, limits, EMPTY_KNOWN_SECRETS);
  return { root, checkout, source, workTarget, layout, reference, publish, open, target, lockfile };
}

describe.skipIf(process.platform !== 'linux')('sealed package Attempt boundary', () => {
  it('preflight and tool floor use the admitted object reference without staging any replacement package tree', async () => {
    const f = await attemptFixture(); await f.publish();
    const opened = await f.open(), context = { sealedNodeModules: opened };
    const floor = () => prepareNativeWorkerInputs(context, 's', f.workTarget, f.checkout, f.layout, limits, limits.maxTotalBytes, 10_000);
    const before = (await readdir(f.root)).sort();
    const preflight = await floor(), tools = await floor();
    expect('sealed' in preflight && preflight.sealed).toBe(opened); expect('sealed' in tools && tools.sealed).toBe(opened);
    await expect(tools.read('read_file', { path: 'node_modules/entry.js' })).resolves.toMatchObject({ status: 'ok', text: expect.stringContaining('export const value = 1;') });
    expect((await readdir(f.root)).sort()).toEqual(before);
    expect(await readdir(f.target)).toEqual([]);
  });

  it.each(['tracked', 'occupied', 'symbolic'] as const)('refuses a %s mount slot at the checkout', async shape => {
    const f = await attemptFixture(); await f.publish();
    if (shape === 'symbolic') await symlink(f.source, f.target);
    else {
      await mkdir(f.target); const path = join(f.target, 'entry.js'); await writeFile(path, 'fixture');
      if (shape === 'tracked') {
        execFileSync(git.gitExecutable, ['add', '--', 'node_modules/entry.js'], { cwd: f.checkout, env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
        await unlink(path);
      }
    }
    await expect(f.open()).rejects.toMatchObject({ code: 'NATIVE_WORKER_DEPENDENCIES_REFUSED' });
  });

  it('refuses an effective lockfile changed by a predecessor before opening tools', async () => {
    const f = await attemptFixture(); await f.publish();
    await writeFile(f.lockfile, '{"lockfileVersion":2}');
    await expect(f.open()).rejects.toMatchObject({ code: 'NATIVE_WORKER_LOCKFILE_CHANGED' });
  });
});

const scopeId = 's', kind = 'coding', local = { issuer: hostname(), subject: String(userInfo().uid) };
const proxyAdmin = { id: 'admin-fixture', issuer: local.issuer, subject: 'second-fixture-person', assurance: 'os-user' as const };
const lockText = '{"lockfileVersion":3}';
const payload = 'fixture-person:fixture-preview-value';
const graph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 't', kind, dependencies: [], acceptanceCriteria: ['exit'] }],
  criterionDefinitions: [{ id: 'exit', version: 1, description: 'Accept successful fixture.', evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }] };
const command = (runId: string) => ({ schemaVersion: 1 as const, scopeId, commandId: runId, runId, graph });

async function fixture(mode?: 'writers' | 'current-source', useFileStore = mode === 'writers', chatLocale?: Locale) {
  composeCore();
  const root = await mkdtemp(join(tmpdir(), 'package-allowance-')), configDir = join(root, '.deckent'), source = join(root, 'package-source'), checkout = join(root, 'checkout');
  roots.push(root);
  for (const folder of [configDir, source, checkout]) await mkdir(folder, { mode: 0o700 });
  const configPath = join(configDir, 'config.json'), policyPath = join(configDir, 'policy.json');
  const options = { env: { HOME: join(root, 'home'), DECKENT_GLOBAL_HOME: join(root, 'home') }, heal: false };
  const { platformPath: globalPath } = resolveGlobalConfigPaths(options.env, process.platform);
  if (useFileStore) {
    await mkdir(dirname(globalPath), { recursive: true, mode: 0o700 });
    await writeFile(globalPath, JSON.stringify({ secrets: { store: FILE_SECRET_STORE_ID } }), { mode: 0o600 });
  }
  if (mode === 'writers') {
    await writeFile(join(configDir, 'bindings.json'), JSON.stringify({ schemaVersion: 1, revision: 'b1', bindings: [] }), { mode: 0o600 });
  }
  const cli = nativeCliAgent('claude-code-stream-json')!, binding = { schemaVersion: 1 as const, connectionId: randomUUID(),
    protocolFamily: cli.command.capabilities.eventStream, profileDigest: 'a'.repeat(64), resourceKey: 'fixture',
    definition: { schemaVersion: 1 as const, executable: '/fixture/unused', configDir: '/fixture/unused', stateDir: '/fixture/unused',
      ownerUid: userInfo().uid, minCliVersion: '2.1.0', delegatedUse: null } };
  const template = createNativeCodingTemplate(undefined, { provider: cli.id, cliVersion: '2.1.317', discovery: { schemaVersion: 1, mode: 'disabled' }, permissionMode: 'unattended' }, binding, 'node-npm');
  const compiled = compileNativeCodingWorkInput(template, { schemaVersion: 1, task: 'Check fixture.', acceptance: 'Done.', scope: { paths: ['check.js'] },
    model: { channelId: 'fixture-channel', modelId: 'fixture-model', auxiliaryModelIds: [] } });
  const settings = {
    ...(chatLocale ? { language: chatLocale } : {}),
    ...(mode === 'current-source' ? { installation: { npmPackageCache: join(root, 'archives') } } : {}),
    service: { identity: { scopeId, serviceId: 'fixture' } }, execution: { git: { gitExecutable: git.gitExecutable, timeoutMs: 10_000 },
      ...(mode === 'current-source' ? { deliveryMode: 'reference' } : {}) },
    admission: { poolId: 'pool', ordering: 'input-order', executionSlots: 2, inFlightSlots: 2, registry: {
      schemaVersion: 1, revision: 'fixture', profiles: [template], kinds: [{ kind, profile: { id: template.id, version: template.version } }],
      evaluators: [{ id: 'test-evaluator', version: 1, implementation: { id: 'test-evaluator', version: 1 } }],
    } },
  };
  const configure = async (value: unknown) => writeFile(configPath, JSON.stringify(value), { mode: 0o600 });
  await configure(settings);
  const rule = (id: string, kind: string, actions: string[], principals = [local], ids: string[] | 'all' = 'all', effect = 'allow') =>
    ({ id, effect, actions, scopes: [scopeId], principals: principals.map(({ issuer, subject }) => ({ issuer, subject })), resource: { kind, ids } });
  async function policy(configWrite: boolean | 'require-approval' = true, runCard = false) {
    const version = mode === 'writers' ? { schemaVersion: 2, roles: [], separationOfDuties: [] } : { schemaVersion: 1 };
    await writeFile(policyPath, JSON.stringify({ ...version, revision: `p-${configWrite}-${runCard}`, restrictions: [], grants: [
      rule('scope', 'scope', ['inspect'], [local, proxyAdmin], [scopeId]),
      rule('approval', 'approval', ['inspect', 'decide'], [local, proxyAdmin]),
      rule('run-create', 'run', ['create'], [local], 'all', runCard ? 'require-approval' : 'allow'),
      rule('run-inspect', 'run', ['inspect']),
      rule('attempt-open', 'attempt', ['execute']),
      rule('secret-register', 'secret', ['set', 'switch']),
      rule('admin', 'operation', ['execute'], [proxyAdmin], ['policy.administer']),
      ...(chatLocale ? [rule('ai-scope', 'scope', ['inspect'], [mcpPrincipalRef(local)], [scopeId]),
        rule('ai-create', 'run', ['create'], [mcpPrincipalRef(local)])] : []),
      ...(configWrite ? [rule('config', 'config', ['write'], [local], [`project:${WORKER_PACKAGE_ALLOWANCE_KEY}`], configWrite === 'require-approval' ? configWrite : 'allow')] : []),
    ] }), { mode: 0o600 });
  }
  await policy();
  await writeFile(join(source, 'check.js'), `// https://${payload}@example.invalid\n// -----BEGIN PRIVATE KEY-----\n`);
  execFileSync('git', ['init', '-q'], { cwd: checkout, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  await writeFile(join(checkout, 'package-lock.json'), lockText);
  const config = await loadConfig(root, options), gate = config.execution!.secretGate;
  const artifacts = await prepareProductDirectory(config.productLayout, 'artifacts');
  const opened = await openConfiguredAttemptStore(root, options), { store } = opened;
  await store.createExecutionPool({ schemaVersion: 1, poolId: 'pool', capacity: { executionSlots: 2, inFlightSlots: 2 } });
  const known = () => (hooks.extraKnown ?? getConfigKnownSecrets(config)) as ReturnType<typeof getConfigKnownSecrets>;
  hooks.prepared = mode === 'current-source' ? undefined : { project: root, workTarget: root, platform: `${process.platform}-${process.arch}`, lockfileDigest: sha256(lockText),
    get known() { return known(); },
    assertCurrent: async () => {}, withCurrentSecrets: (work: () => Promise<unknown>) => work(),
    review: () => reviewSealedWorkerTree(source, 'node_modules', gate, known()), seal: (reference: Parameters<typeof sealedWorkerTreeLocation>[1]) =>
      sealWorkerTree(source, sealedWorkerTreeLocation(artifacts, reference), 'node_modules', reference.listDigest, gate, known(), undefined, {
        run: (key, work) => withConfigWriteLock(key, work, gate.timeoutMs), maxBytes: async () => config.installation.sealedPackageStoreMaxBytes,
      }) };
  const context = () => loadConfiguredScopeContext(root, scopeId, { ...options, force: true }, 'write');
  const withAdmission = async <T>(work: (app: RunAdmissionApplication, authority: RunCreationAuthority, ctx: Awaited<ReturnType<typeof context>>) => Promise<T>, beforeCommit?: () => Promise<void>) => {
    const ctx = await context();
    const persistence = {
      loadRunReceipt: store.loadRunReceipt.bind(store), loadRunWorkspaceCustody: store.loadRunWorkspaceCustody.bind(store),
      async createRun(...args: Parameters<typeof store.createRun>) { await beforeCommit?.(); return store.createRun(...args); },
    };
    return withRunCreationAuthority(ctx, authority => work(new RunAdmissionApplication(persistence, verifiedPrincipal(ctx.principal), authority, { authorize: async () => {} }, {
      inputs: nativePackageAdmission(configuredWorkerPackagePorts(root, options), ctx, selectNativePackageProfile),
      async resolve(admission) { const execution = fixtureExecution(admission.graph);
        return { now: Date.now(), layoutRevision: ctx.layout.revision, execution: { ...execution, tasks: execution.tasks.map(task => ({ ...task, profile: compiled })) },
          policy: { schemaVersion: 2, poolId: 'pool', capacity: { executionSlots: 2, inFlightSlots: 2 }, ordering: ['t'] } }; },
    }), authority, ctx));
  };
  const run = (runId: string, beforeCommit?: () => Promise<void>, baseRevision?: string) =>
    withAdmission(app => app.create(command(runId), undefined, baseRevision ? async () => ({ schemaVersion: 1, scopeId, runId, baseRevision,
      source: { schemaVersion: 1, adapter: { id: 'git', version: 1 }, sourceFingerprint: 'c'.repeat(64) } }) : undefined), beforeCommit);
  const propose = (runId: string, checkPackageCard?: RunPackageCardCheck) => withAdmission(async (app, authority, ctx) => {
    const { id, issuer, subject } = ctx.principal, draft = proposalFixture('small', { id, issuer, subject });
    const proposals = await openSqliteRunProposalStore(await ctx.path(), ctx.config.storage.sqlite);
    try {
      return await new RunProposalApplication(proposals, verifiedPrincipal(ctx.principal), authority, app, {
        clock: new SystemTrustedClock(), async verifySource() {}, async loadBudget() { return null; },
        async classifySpending() { return { semantics: 'not-metered', digest: sha256('fixture-subscription') }; },
      }).propose({ ...draft, scopeId, runId, commandId: runId, proposalId: runId,
        graph: { ...graph, tasks: graph.tasks.map(task => ({ ...task, workClass: 'small' })) } }, undefined, checkPackageCard);
    } finally { proposals.close(); }
  });
  const text: string[] = [];
  const change = (action: 'grant' | 'withdraw', commandId = randomUUID(), locale: 'en' | 'tr' = 'en') =>
    changeConfiguredPackageAllowance(root, { action, scopeId, kind, commandId, locale }, options, async card => { text.push(card.title, ...card.lines); return true; });
  const read = async (runId: string) => {
    const run = (await store.loadRun(scopeId, runId))!, profile = run.execution.tasks[0]!.profile, reference = resolveNativeCliWorkerProfile(profile).dependencies;
    if (reference?.state !== 'sealed') throw Error('fixture Run lacks a sealed reference');
    return { reference, profile };
  };
  const use = async <T>(runId: string, action: 'admit' | 'open', work: () => Promise<T>) =>
    withPackageUse(root, await context(), options, [await read(runId)], action, runId, work, action === 'open' ? async fresh => {
      const identity = { scopeId, runId, taskId: 't', attemptId: 'fixture-opening', layoutRevision: fresh.layout.revision, generation: 1 };
      await new DispatchPolicyAuthorization(contextPolicySource(fresh, fresh.document)).authorizeIdentity('execute', identity, fresh.principal);
    } : undefined);
  const audit = async () => withScopeAudit(await context(), reader => reader.list(scopeId, 0, 500), false, 'read');
  return { artifact: sealedWorkerTreeLocation, artifacts, root, source, checkout, config, configPath, globalPath, options, store, policy, text, run, propose, change, read, use, audit, context, opened };
}

it.skipIf(process.platform !== 'linux')('chain: full witnessed list, two Runs, independent Run card, Attempt opening and negative input cases', async () => {
  const f = await fixture();
  try {
    await expect(f.run('baseline-one')).rejects.toMatchObject({ code: 'RUN_APPROVAL_REQUIRED' });
    await f.policy(true, true);
    await expect(f.run('baseline-two')).rejects.toMatchObject({ code: 'RUN_APPROVAL_REQUIRED' });
    await f.policy(true);
    const grant = await f.change('grant');
    const authored = JSON.parse(await readFile(f.configPath, 'utf8'));
    const ctx = await f.context();
    await expect(createConfiguredConfigApplication(f.root, f.options).unset({
      commandId: 'ordinary-set', scopeId, layer: 'project', keyPath: WORKER_PACKAGE_ALLOWANCE_KEY, principal: ctx.principal,
    })).rejects.toMatchObject({ code: 'NATIVE_WORKER_DEPENDENCIES_REFUSED' });
    expect(JSON.parse(await readFile(f.configPath, 'utf8'))).toEqual(authored);
    expect(grant).toMatchObject({ status: 'active', version: 1 });
    for (const row of ['check.js', 'pattern:private-key-block', 'pattern:url-userinfo', 'until withdrawal']) expect(f.text.join('\n')).toContain(row);
    expect(f.text.join('\n')).not.toContain(payload);
    await f.run('reused-one');
    await f.policy(true, true);
    const pending = await f.run('reused-two').catch((error: { code: string; params: { approvalId: string } }) => error);
    expect(pending).toMatchObject({ code: 'RUN_APPROVAL_REQUIRED' });
    if (!('params' in pending)) throw Error('no Run card');
    const r = approvalRecordSchema.parse(await configuredApproval(f.root, 'inspect', { schemaVersion: 1, scopeId, approvalId: pending.params.approvalId }, f.options));
    expect(r.request).toMatchObject({ subject: { kind: 'run-create' } });
    expect(r.request).not.toHaveProperty('preview');
    await configuredApproval(f.root, 'decide', { schemaVersion: 1, scopeId, approvalId: r.request.approvalId, expectedRevision: 0,
      commandId: 'run-card-answer', decision: 'allow', reason: 'Fixture Run card', channel: 'local-terminal-card' }, f.options);
    await f.run('reused-two');
    const one = await f.read('reused-one'), two = await f.read('reused-two');
    expect(two.reference).toEqual(one.reference);
    const opened = await f.use('reused-two', 'open', () => openSealedNativeInput(two.reference, { root: f.root, workTarget: f.root, checkout: f.checkout, scopeId, config: f.config, layout: f.config.productLayout }));
    expect(opened.digest).toBe(two.reference.listDigest);
    const status = await inspectConfiguredNativeInputs(f.root, scopeId, f.options, 'reused-two');
    expect(status).toMatchObject({ kind: 'run', rows: [{ decision: { version: 1, decisionId: one.reference.allowance!.decisionId, person: readLocalOsIdentity().id,
      decidedAt: expect.any(Number) }, listDigest: one.reference.listDigest, lockfileDigest: one.reference.lockfileDigest }] });
    expect(JSON.stringify(status)).not.toContain(payload);
    hooks.extraKnown = knownSecretValues([payload]);
    await expect(f.use('reused-two', 'open', async () => {})).rejects.toMatchObject({ code: 'WORKER_TREE_SECRET_REFUSED' });
    hooks.extraKnown = undefined;
    const objectPath = f.artifact(f.artifacts, two.reference);
    const manifestPath = join(objectPath, 'manifest.json'), original = await readFile(manifestPath, 'utf8'), manifest = JSON.parse(original);
    const row = manifest.entries.find((entry: { rules: string[] }) => entry.rules.length > 1);
    row.rules.pop();
    await chmod(manifestPath, 0o600);
    await writeFile(manifestPath, JSON.stringify(manifest));
    await chmod(manifestPath, 0o400);
    await expect(f.use('reused-two', 'open', async () => {})).rejects.toMatchObject({ code: 'NATIVE_WORKER_DEPENDENCIES_REFUSED' });
    await chmod(manifestPath, 0o600);
    await writeFile(manifestPath, original);
    await chmod(manifestPath, 0o400);
    const { rename } = await import('node:fs/promises');
    await rename(objectPath, objectPath + '.missing');
    const handed = vi.fn(async () => {});
    await expect(f.use('reused-two', 'open', handed)).rejects.toMatchObject({ code: 'NATIVE_WORKER_DEPENDENCIES_REFUSED' });
    expect(handed).not.toHaveBeenCalled();
    await writeFile(join(f.source, 'check.js'), '// changed rule rows\n');
    await expect(f.run('changed-list')).rejects.toMatchObject({ code: 'NATIVE_WORKER_DEPENDENCIES_REFUSED' });
    console.log('chain: two baseline cards, one reusable card, two independent Run receipts, one separate Run card, and one bounded Attempt open');
  } finally { f.store.close(); }
});

it.skipIf(process.platform !== 'linux')('withdrawal, stale pointer, witnessed actors, version and audit/publication interruptions', async () => {
  const f = await fixture();
  try {
    const grantId = randomUUID(), withdrawId = randomUUID();
    hooks.failPublication = true;
    await expect(f.change('grant', grantId)).rejects.toThrow('fixture interruption');
    expect((await readFile(f.configPath, 'utf8')).includes('packageAllowances')).toBe(false);
    await expect(f.run('before-publication')).rejects.toMatchObject({ code: 'RUN_APPROVAL_REQUIRED' });
    hooks.failPublication = false;
    const firstResponse = await f.change('grant', grantId);
    await expect(Promise.resolve(firstResponse).then(() => { throw Error('fixture lost reply after publication'); })).rejects.toThrow('lost reply');
    const first = await f.change('grant', grantId);
    expect(await f.change('grant', grantId)).toEqual(first);
    await f.run('winner');
    const { reference } = await f.read('winner'), key = reference.allowance!.partition, backup = await readFile(f.configPath, 'utf8');
    expect((await f.audit()).filter(row => row.event.eventId === packageIntentId(key, grantId))).toHaveLength(1);
    await expect(withMcpPrincipal(() => f.change('withdraw'))).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    await expect(withMcpPrincipal(() => f.change('grant'))).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    await expect(withMcpPrincipal(() => f.run('ai-without-run-create'))).rejects.toMatchObject({ code: expect.stringMatching(/POLICY_DENIED|POLICY_SCOPE_DENIED/) });
    hooks.person = { ...proxyAdmin, id: 'unrelated', subject: 'unrelated-person' };
    await expect(f.change('withdraw')).rejects.toBeDefined();
    hooks.person = undefined;
    await f.policy('require-approval');
    await expect(f.change('withdraw')).rejects.toMatchObject({ code: 'POLICY_APPROVAL_UNSUPPORTED' });
    await f.policy(false);
    await expect(f.change('withdraw')).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    hooks.person = proxyAdmin;
    expect(await f.change('withdraw', withdrawId)).toMatchObject({ status: 'withdrawn', version: 1 });
    expect(await f.change('withdraw', withdrawId)).toMatchObject({ status: 'withdrawn', version: 1 });
    hooks.person = undefined;
    await f.policy();
    await writeFile(f.configPath, backup);
    await expect(f.use('winner', 'open', async () => {})).rejects.toMatchObject({ code: 'NATIVE_WORKER_DEPENDENCIES_REFUSED' });
    expect(await f.change('grant')).toMatchObject({ status: 'active', version: 2 });
    await expect(f.use('winner', 'open', async () => {})).rejects.toMatchObject({ code: 'NATIVE_WORKER_DEPENDENCIES_REFUSED' });
    const activity = await withScopeAudit(await f.context(), audit => packageActivity(audit, scopeId, key), false, 'read');
    expect(activity.version).toBe(2);
    const secondWithdrawalId = randomUUID();
    hooks.failPublication = true;
    await expect(f.change('withdraw', secondWithdrawalId)).rejects.toThrow('fixture interruption');
    expect((await readFile(f.configPath, 'utf8')).includes('packageAllowances')).toBe(true);
    await expect(f.run('after-withdraw-before-cleanup')).rejects.toMatchObject({ code: 'NATIVE_WORKER_DEPENDENCIES_REFUSED' });
    hooks.failPublication = false;
    expect(await f.change('withdraw', secondWithdrawalId)).toMatchObject({ status: 'withdrawn', version: 2 });
    const history = await inspectConfiguredNativeInputs(f.root, scopeId, f.options, 'winner');
    expect(history).toMatchObject({ rows: [{ decision: { version: 1, person: readLocalOsIdentity().id } }] });
    console.log('withdrawal: stored intent before a refused publication; repeat returned same grant; admin and approver retired versions 1 and 2');
  } finally { f.store.close(); }
});

it.skipIf(process.platform !== 'linux')('per-target lock orders withdrawal before and after both admission and Attempt handover', async () => {
  const f = await fixture();
  try {
    for (const action of ['admit', 'open'] as const) {
      await f.change('grant');
      const runId = 'race-' + action;
      await f.run(runId);
      const { reference, profile } = await f.read(runId), expected = reference.allowance!;
      const mismatchedUse = vi.fn(async () => 'unexpected');
      await expect(withPackageUse(f.root, await f.context(), f.options, [{ reference, profile: { ...profile, version: profile.version + 1 } }], action, runId, mismatchedUse))
        .rejects.toMatchObject({ code: 'NATIVE_WORKER_DEPENDENCIES_REFUSED' });
      await expect(withPackageUse(f.root, await f.context(), f.options, [{ reference: { ...reference, workTarget: f.checkout }, profile }], action, runId, mismatchedUse))
        .rejects.toMatchObject({ code: 'NATIVE_WORKER_DEPENDENCIES_REFUSED' });
      expect(mismatchedUse).not.toHaveBeenCalled();
      const released = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
      const held = async () => { entered.resolve(); await released.promise; };
      const effect = action === 'admit' ? f.run(runId + '-effect', held) : f.use(runId, action, async () => {
        await held();
        return openSealedNativeInput(reference, { root: f.root, workTarget: f.root, checkout: f.checkout, scopeId, config: f.config, layout: f.config.productLayout });
      });
      await Promise.race([entered.promise, effect]);
      const withdraw = f.change('withdraw');
      released.resolve();
      const completed = await effect;
      if (action === 'admit') {
        expect(completed).toMatchObject({ run: { runId: runId + '-effect' } });
        expect(await f.store.loadRunReceipt(scopeId, runId + '-effect')).not.toBeNull();
      } else expect(completed).toMatchObject({ digest: reference.listDigest });
      expect(await withdraw).toMatchObject({ status: 'withdrawn', version: expected.version });
      const audit = await f.audit(), opened = audit.filter(row => row.event.subject.kind === 'authority-decision'
        && row.event.subject.action === 'package-' + action && row.event.subject.envelope.commandId === (action === 'admit' ? runId + '-effect' : runId)).at(-1)!;
      const ended = audit.filter(row => row.event.subject.kind === 'authority-decision' && row.event.subject.action === 'package-withdraw'
        && row.event.subject.resource.id === expected.partition).at(-1)!;
      expect(opened.sequence).toBeLessThan(ended.sequence);
      const after = vi.fn(async () => 'unexpected');
      await expect(f.use(runId, action, after)).rejects.toMatchObject({ code: 'NATIVE_WORKER_DEPENDENCIES_REFUSED' });
      expect(after).not.toHaveBeenCalled();
      if (action === 'admit') {
        const next = runId + '-after-withdrawal';
        await expect(f.run(next)).rejects.toMatchObject({ code: 'RUN_APPROVAL_REQUIRED' });
        expect(await f.store.loadRunReceipt(scopeId, next)).toBeNull();
      }
      console.log(JSON.stringify({ action, useSequence: opened.sequence, withdrawalSequence: ended.sequence, withdrawalFirst: 'refused before handover' }));
    }
  } finally { f.store.close(); }
});

it.skipIf(process.platform !== 'linux')('copied managed rows and global inheritance never grant another target or Run', async () => {
  const first = await fixture();
  try {
    await first.change('grant');
    const authored = JSON.parse(await readFile(first.configPath, 'utf8'));
    const other = await fixture();
    try {
      const targetConfig = JSON.parse(await readFile(other.configPath, 'utf8'));
      await writeFile(other.configPath, JSON.stringify({ ...targetConfig, toolchains: authored.toolchains }));
      await expect(other.run('different-project')).rejects.toMatchObject({ code: 'RUN_APPROVAL_REQUIRED' });
      expect(await other.store.loadRunReceipt(scopeId, 'different-project')).toBeNull();
      await writeFile(other.configPath, JSON.stringify(targetConfig));
      const { platformPath } = resolveGlobalConfigPaths(other.options.env, process.platform);
      await mkdir(join(platformPath, '..'), { mode: 0o700, recursive: true });
      await writeFile(platformPath, JSON.stringify({ toolchains: authored.toolchains }), { mode: 0o600 });
      await expect(other.run('global-only')).rejects.toMatchObject({ code: 'RUN_APPROVAL_REQUIRED' });
      expect(await other.store.loadRunReceipt(scopeId, 'global-only')).toBeNull();
      console.log('authority: project copy and global-only rows leave the person card in place');
    } finally { other.store.close(); }
  } finally { first.store.close(); }
});

const writerCollisions = (['policy', 'secret'] as const).flatMap(writer =>
  (['admit', 'open'] as const).flatMap(effect => (['writer', 'use'] as const).map(first => ({ writer, effect, first }))));

it.skipIf(process.platform !== 'linux').each(writerCollisions)('authority collision: $writer, $effect, $first first', async ({ writer, effect, first }) => {
  const f = await fixture('writers');
  const release = Promise.withResolvers<void>(), firstHeld = Promise.withResolvers<void>(), secondRequested = Promise.withResolvers<void>();
  let writerTask: Promise<unknown> | undefined, effectTask: Promise<unknown> | undefined;
  try {
    await f.change('grant');
    await f.run('opening-run');
    const { reference } = await f.read('opening-run'), context = await f.context();
    const effectId = effect === 'admit' ? 'collision-run' : 'opening-run';
    const policyPath = productResourcePath(context.layout, 'policy'), custodyPath = f.globalPath + '.secret-custody';
    const lockPath = writer === 'policy' ? policyPath : custodyPath, heldByUse: string[] = [], trace: string[] = [];
    const handover = vi.fn(async () => {
      const result = await openSealedNativeInput(reference, { root: f.root, workTarget: f.root, checkout: f.checkout, scopeId, config: f.config, layout: f.config.productLayout });
      trace.push('handed over');
      return result;
    });
    hooks.lock = async (path, phase) => {
      const lane = collision.getStore();
      if (lane === 'use' && phase === 'held' && (path === custodyPath || path === policyPath)) heldByUse.push(path);
      if (path !== lockPath || !lane) return;
      if (phase === 'request' && lane !== first) secondRequested.resolve();
      if (phase !== 'held' || lane !== 'writer') return;
      if (first === 'writer') {
        firstHeld.resolve();
        await release.promise;
      } else if (effect === 'admit') {
        expect(await f.store.loadRunReceipt(scopeId, effectId)).not.toBeNull();
        trace.push('Run receipt visible');
      } else {
        expect(handover).toHaveBeenCalledOnce();
        expect(trace).toEqual(['handed over']);
      }
    };
    const change = () => collision.run('writer', async () => {
      if (writer === 'policy') {
        await contextPolicySource(context).updateAuthority(({ policy }) => ({
          write: { policy: { ...policy, revision: 'p-revoked', grants: policy.grants.filter(rule => rule.id !== 'run-create' && rule.id !== 'attempt-open') },
            bindings: null, order: 'policy-first' }, result: null,
        }));
        expect((await contextPolicySource(context).load()).grants.some(rule => rule.id === 'attempt-open')).toBe(false);
      } else {
        await executeConfiguredRuntimeSecretOperation(f.root, { schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId: 'fixture-secret',
          operation: 'setSecret', delivery: { maxResultBytes: 4096 }, input: { schemaVersion: 1, scopeId, name: 'PACKAGE_FIXTURE', value: payload } },
        { pid: process.pid, uid: userInfo().uid, gid: userInfo().gid, assurance: 'linux-so-peercred' }, 4096, f.options);
      }
      trace.push('change committed');
    });
    const use = () => collision.run('use', async () => {
      const boundary = async () => {
        if (first === 'use') { firstHeld.resolve(); await release.promise; }
      };
      return effect === 'admit' ? f.run(effectId, boundary) : f.use(effectId, 'open', async () => { await boundary(); return handover(); });
    });
    const leading = first === 'writer' ? (writerTask = change()) : (effectTask = use());
    await Promise.race([firstHeld.promise, leading.then(() => { throw Error('leading operation skipped the boundary'); })]);
    const trailing = first === 'writer' ? (effectTask = use()) : (writerTask = change());
    await Promise.race([secondRequested.promise, trailing.then(() => { throw Error('trailing operation skipped the shared lock'); })]);
    const outcome = first === 'writer'
      ? expect(effectTask).rejects.toMatchObject({ code: 'NATIVE_WORKER_DEPENDENCIES_REFUSED' })
      : expect(effectTask).resolves.toMatchObject(effect === 'admit' ? { run: { runId: effectId } } : { digest: reference.listDigest });
    release.resolve();
    await Promise.all([writerTask, outcome]);
    hooks.lock = undefined;
    expect(heldByUse).toEqual([custodyPath, policyPath]);
    const records = (await f.audit()).filter(({ event: { subject } }) =>
      subject.kind === 'authority-decision' && subject.action === 'package-' + effect && subject.envelope.commandId === effectId);
    expect(records).toHaveLength(first === 'use' ? 1 : 0);
    expect(trace).toEqual(first === 'writer' ? ['change committed'] : [effect === 'admit' ? 'Run receipt visible' : 'handed over', 'change committed']);
    if (effect === 'admit') {
      const receipt = await f.store.loadRunReceipt(scopeId, effectId);
      if (first === 'writer') expect(receipt).toBeNull();
      else expect(receipt?.snapshot.identity.runId).toBe(effectId);
    } else expect(handover).toHaveBeenCalledTimes(first === 'use' ? 1 : 0);
    const later = vi.fn(async () => null);
    await expect(f.use('opening-run', 'open', later)).rejects.toMatchObject({
      code: writer === 'policy' ? 'POLICY_DENIED' : 'WORKER_TREE_SECRET_REFUSED',
    });
    expect(later).not.toHaveBeenCalled();
    console.log(JSON.stringify({ writer, effect, first, trace, useSequence: records[0]?.sequence ?? null, nextOpen: 'refused before handover' }));
  } finally {
    release.resolve();
    await Promise.allSettled([writerTask, effectTask]);
    hooks.lock = undefined;
    f.store.close();
  }
}, 15_000);

async function committedPackageVersions(root: string, extra = '') {
  const source = join(root, 'node_modules', 'pkg'), archive = join(root, 'package'), tarball = join(root, 'fixture.tgz');
  await mkdir(source, { recursive: true });
  await mkdir(archive);
  const files = { 'package.json': '{"name":"pkg","version":"1.0.0"}', 'check.js': `// https://${payload}@example.invalid\n${extra}` };
  for (const [name, value] of Object.entries(files)) {
    await writeFile(join(source, name), value);
    await writeFile(join(archive, name), value);
  }
  execFileSync('tar', ['--format=ustar', '-czf', tarball, '-C', root, 'package']);
  const raw = await readFile(tarball), hash = createHash('sha512').update(raw), hex = hash.copy().digest('hex');
  const entry = join(root, 'archives', 'content-v2', 'sha512', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(entry, raw, { mode: 0o644 });
  const lock = JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/pkg': { version: '1.0.0', integrity: 'sha512-' + hash.digest('base64') } } });
  const lockfile = 'package-lock.json', fileList = 'deckent-package-files.json';
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: root, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, encoding: 'utf8',
  }).trim();
  git('init', '-q');
  async function commit(lockText: string, includeRuleRow: boolean) {
    const entries = Object.entries(files).filter(([path]) => includeRuleRow || path !== 'check.js')
      .map(([path, value]) => ({ path: 'pkg/' + path, digest: sha256(value) }));
    await writeFile(join(root, lockfile), lockText);
    await writeFile(join(root, fileList), JSON.stringify({ schemaVersion: 1, entries }));
    git('add', lockfile, fileList);
    git('commit', '-qm', 'Fixture package version');
    return git('rev-parse', 'HEAD');
  }
  const approved = await commit(lock, true), listChanged = await commit(lock, false), lockChanged = await commit(lock + '\n', true);
  const select = (revision: string) => git('update-ref', 'HEAD', revision);
  select(approved);
  return { approved, listChanged, lockChanged, select };
}

const crashAtPackageBoundary = String.raw`
import { readFileSync, writeSync } from 'node:fs';
import { AuditApplication } from '#engine/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { withPackageUse } from '#composition/core/workspace-patch/index.js';
const [boundary, root, ...args] = process.argv.slice(1);
const record = AuditApplication.prototype.record;
function kill() {
  writeSync(1, 'reached ' + boundary + '\n');
  process.kill(process.pid, 'SIGKILL');
}
AuditApplication.prototype.record = function (event) {
  const subject = event.subject;
  if (boundary === 'retirement append' && subject.action === 'package-retire') kill();
  const result = record.call(this, event);
  if (boundary === 'write intent' && subject.keyPath === 'toolchains.packageAllowances') kill();
  if (boundary === 'grant publication' && subject.action === 'package-grant') kill();
  return result;
};
if (boundary === 'retirement append') {
  const { scopeId, options, binding } = JSON.parse(readFileSync(0, 'utf8'));
  const context = await loadConfiguredScopeContext(root, scopeId, { ...options, force: true }, 'read');
  await withPackageUse(root, context, options, [binding], 'open', 'crash-fixture', async () => {
    throw Error('unexpected handover');
  });
} else {
  const { main } = await import('#composition/core/cli/internal/cli-main.js');
  process.chdir(root);
  process.exitCode = await main(args);
}
`;
const crashProbe = (boundary: string, root: string, ...args: string[]) =>
  ['--input-type=module', '--eval', crashAtPackageBoundary, '--', boundary, root, ...args];

it.skipIf(process.platform !== 'linux')('refuses a grant before the card when the package contains an unreferenced registered value', async () => {
  const f = await fixture('current-source', true);
  try {
    await committedPackageVersions(f.root);
    await executeConfiguredRuntimeSecretOperation(f.root, { schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId: 'grant-fixture-secret',
      operation: 'setSecret', delivery: { maxResultBytes: 4096 }, input: { schemaVersion: 1, scopeId, name: 'PACKAGE_FIXTURE', value: payload } },
    { pid: process.pid, uid: userInfo().uid, gid: userInfo().gid, assurance: 'linux-so-peercred' }, 4096, f.options);
    await expect(f.change('grant', 'invalid-command-id')).rejects.toMatchObject({ code: 'CLI_USAGE' });
    await expect(f.change('grant')).rejects.toMatchObject({ code: 'WORKER_TREE_SECRET_REFUSED' });
    expect(f.text).toEqual([]);
    expect((await readFile(f.configPath, 'utf8')).includes('packageAllowances')).toBe(false);
  } finally { f.store.close(); }
});

type PackageFixture = Awaited<ReturnType<typeof fixture>>;
async function registerPackageValue(f: PackageFixture, value = payload, perRun = true) {
  await executeConfiguredRuntimeSecretOperation(f.root, { schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId: 'per-run-fixture-secret',
    operation: 'setSecret', delivery: { maxResultBytes: 4096 }, input: { schemaVersion: 1, scopeId, name: 'PACKAGE_FIXTURE', value } },
  { pid: process.pid, uid: userInfo().uid, gid: userInfo().gid, assurance: 'linux-so-peercred' }, 4096, f.options);
  const { config } = await f.context();
  expect(getConfigKnownSecrets(config).spans(value)).toHaveLength(0);
  expect((await readFile(f.configPath, 'utf8')).includes('$DECK:PACKAGE_FIXTURE')).toBe(false);
  if (perRun) expect(config.toolchains.packageAllowances).toBeUndefined();
}

async function approvePackageRun(f: PackageFixture, runId: string) {
  const pending = await f.run(runId).catch((error: unknown) => error);
  expect(pending).toMatchObject({ code: 'RUN_APPROVAL_REQUIRED', params: { approvalId: expect.any(String) } });
  const { params: { approvalId } } = pending as { params: { approvalId: string } };
  const request = await configuredApproval(f.root, 'inspect', { schemaVersion: 1, scopeId, approvalId }, f.options);
  expect(JSON.stringify(request).includes(payload)).toBe(false);
  await configuredApproval(f.root, 'decide', { schemaVersion: 1, scopeId, approvalId, expectedRevision: 0,
    commandId: 'per-run-card-answer', decision: 'allow', reason: 'Fixture Run card', channel: 'local-terminal-card' }, f.options);
}

const packageApprovals = (f: PackageFixture) =>
  configuredApproval(f.root, 'list', { schemaVersion: 1, scopeId, afterId: null, limit: 10 }, f.options);

const overLimitText = {
  en: 'The complete package review is too large for a per-Run approval. An authorized person may grant a reusable package allowance with deckent coding template --allow-dependencies --kind <kind> --scope <scope>. Without that allowance, the Run cannot start with this package list.',
  tr: 'Paket incelemesinin tamamı işe özel onaya sığmıyor. Yetkili bir kişi deckent coding template --allow-dependencies --kind <tür> --scope <kapsam> komutuyla yeniden kullanılabilir paket izni verebilir. Bu izin olmadan iş bu paket listesiyle başlamaz.',
};
const cardTooLargeText = {
  en: 'The plan and complete package review do not fit in the chat approval card. Start a new request under your own authority with deckent do --scope <scope> --request "<request>" or /do <request>. If approval is requested, use /approvals or deckent approval inspect to read the package risk warning and every match row.',
  tr: 'Plan ve paket incelemesinin tamamı sohbet onay kartına sığmıyor. Kendi yetkinizle deckent do --scope <kapsam> --request "<istek>" veya /do <istek> komutuyla yeni bir istek başlatın. Onay istenirse paket risk uyarısını ve bütün eşleşme satırlarını /approvals veya deckent approval inspect ile okuyun.',
};

it.skipIf(process.platform !== 'linux')('shows the stored package review limit on do, run propose and ordinary chat in English and Turkish', async () => {
  for (const locale of ['en', 'tr'] as const) {
    const f = await fixture(undefined, true, locale);
    try {
      await Promise.all(Array.from({ length: 150 }, (_, index) => writeFile(join(f.source, `package-check-${index}.js`), '// https://fixture:x@example.invalid\n')));
      const direct = await f.run('over-limit-direct').catch((error: unknown) => error);
      expect.soft(direct).toMatchObject({ code: 'NATIVE_WORKER_DEPENDENCIES_REFUSED', params: { preview: 'over-limit' } });
      const rejected = await f.propose('over-limit-proposal');
      expect.soft(rejected).toMatchObject({ proposal: { status: 'rejected', approval: null }, reasonParams: { preview: 'over-limit' }, run: null });
      expect.soft(await f.propose('over-limit-proposal')).toEqual(rejected);
      const output: string[] = [], context = { root: f.root, env: f.options.env, stdout: { write: (line: string) => { output.push(line); } } };
      await doCommand(['do', '--scope', scopeId, '--request', 'Check packages', '--lang', locale], { ...context, planRun: async () => rejected });
      expect.soft(output.pop()).toContain(overLimitText[locale]);
      await runProposalCommand(['run', 'propose', '--proposal', '-', '--lang', locale],
        { ...context, stdin: Readable.from([JSON.stringify(rejected.proposal.proposal)]), proposeRun: async () => rejected }, locale);
      expect.soft(output.pop()).toContain(overLimitText[locale]);
      const events: AgentTurnStreamEvent[] = [];
      const proposals = createAgentProposals({ projectRoot: f.root, options: f.options, scopeId, turnId: 'review-too-large', locale,
        peer: { pid: process.pid, uid: userInfo().uid, gid: userInfo().gid, assurance: 'linux-so-peercred' }, signal: new AbortController().signal,
        plan: () => withMcpPrincipal(() => f.propose('over-limit-chat')), views: async () => ({ cardLines: () => [], schemaChoices: () => [] }),
        emit: event => events.push(event) });
      const outcome = await proposals.apply('propose_work', { request: 'Check packages' }, 'tool-call');
      expect.soft(outcome).toMatchObject({ status: 'error', text: expect.stringContaining(overLimitText[locale]) });
      expect.soft(events).toContainEqual({ kind: 'text', text: overLimitText[locale] });
      expect(events.some(event => event.kind === 'approval.requested')).toBe(false);
    } finally { f.store.close(); }
  }
});

function durableRows(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all();
    return Object.fromEntries(tables.map(({ name }) => [String(name), db.prepare(`SELECT * FROM "${String(name).replaceAll('"', '""')}"`).all()]));
  } finally { db.close(); }
}

it.skipIf(process.platform !== 'linux').each([
  { route: 'ordinary chat', locale: 'en', risk: 'If you approve an unregistered real secret' },
  { route: 'same-turn plan', locale: 'tr', risk: 'Sisteme kayıtlı olmayan gerçek bir sırrı onaylarsanız' },
] as const)('$route shows every sealed package review row before the person decides and refuses registered values', async ({ route, locale, risk }) => {
  const f = await fixture('current-source', true, locale);
  const peer = { pid: process.pid, uid: userInfo().uid, gid: userInfo().gid, assurance: 'linux-so-peercred' as const };
  const ai = mcpPrincipalRef(local);
  try {
    await committedPackageVersions(f.root);
    async function chat(runId: string, approve: boolean, planText = 'Fixture plan') {
      const events: AgentTurnStreamEvent[] = [], controller = new AbortController();
      let response: Awaited<ReturnType<PackageFixture['propose']>> | undefined, answer: Promise<unknown> | undefined, answerError: unknown;
      const send = async (check?: RunPackageCardCheck) => response = await withMcpPrincipal(() => f.propose(runId, check));
      const sameTurn = route === 'same-turn plan' ? { callId: 'tool-call', invocationId: 'fixture-invocation', chosenBrain: null,
        prepare: async () => ({ status: 'ok' as const, text: 'prepared' }), finalize: (_signal: AbortSignal, check?: RunPackageCardCheck) => send(check), admit: () => send() } : null;
      const proposals = createAgentProposals({ projectRoot: f.root, options: f.options, peer, scopeId, turnId: runId, signal: controller.signal, locale,
        sameTurn, plan: (_command, _signal, _observe, check) => send(check), views: async () => ({ cardLines: () => [planText], schemaChoices: () => [] }),
        emit(event) {
          events.push(event);
          if (event.kind !== 'approval.requested') return;
          answer = withLocalPrincipalChannel(undefined, async () => {
            expect(approve).toBe(true);
            expect(await f.store.loadRun(scopeId, runId)).toBeNull();
            const stored = approvalRecordSchema.parse(await configuredApproval(f.root, 'inspect', { schemaVersion: 1, scopeId, approvalId: event.approvalId }, f.options));
            expect(stored.request.requester).toMatchObject(ai);
            expect(stored.request).toMatchObject({ preview: { cut: null, text: expect.stringContaining(risk) } });
            if (stored.request.schemaVersion !== 3 || !stored.request.preview) throw new Error('Missing sealed package preview');
            expect(event.preview).toContain(stored.request.preview.text);
            expect(event.preview).toContain('pkg/check.js · pattern:url-userinfo');
            expect(event.preview).not.toContain(payload);
            const decided = await configuredApproval(f.root, 'decide', { schemaVersion: 1, scopeId, approvalId: event.approvalId,
              expectedRevision: event.revision, commandId: 'package-chat-answer', decision: 'allow', reason: 'Reviewed package rows', channel: 'local-terminal-card' }, f.options);
            expect(decided).toMatchObject({ decision: { decision: 'allow', actor: local } });
          }).catch(error => { answerError = error; controller.abort(); });
        },
      });
      const turn = sameTurn ? proposals.finishSameTurn(controller.signal) : proposals.apply('propose_work', { request: 'Check the package' }, 'tool-call');
      const outcome = await turn.catch((error: unknown) => error).finally(async () => { await answer; });
      if (answerError) throw answerError;
      return { outcome, response, events };
    }
    const allowed = await chat('package-chat-approved', true);
    expect(allowed.events.map(event => event.kind)).toEqual(expect.arrayContaining(['approval.requested', 'approval.settled', 'work']));
    expect(allowed.response).toMatchObject({ proposal: { status: 'accepted', proposal: { proposer: ai } }, run: { authority: { approval: { approvalId: expect.any(String) } } } });
    expect((await f.read('package-chat-approved')).reference.allowance).toBeUndefined();
    const before = durableRows(f.opened.path);
    const overflow = await chat('package-chat-overflow', false, 'x'.repeat(65_400));
    expect.soft(overflow.events.some(event => event.kind === 'approval.requested')).toBe(false);
    if (route === 'ordinary chat') {
      expect.soft(overflow.outcome).toMatchObject({ status: 'error', text: expect.stringContaining(cardTooLargeText[locale]) });
      expect.soft(overflow.events).toContainEqual({ kind: 'text', text: cardTooLargeText[locale] });
    } else {
      expect.soft(overflow.outcome).toMatchObject({ code: 'CHAT_PACKAGE_APPROVAL_CARD_TOO_LARGE', message: cardTooLargeText[locale] });
    }
    const after = durableRows(f.opened.path);
    expect.soft(Object.keys(after).filter(table => JSON.stringify(after[table]) !== JSON.stringify(before[table]))).toEqual([]);
    expect(await f.store.loadRun(scopeId, 'package-chat-overflow')).toBeNull();
    await registerPackageValue(f);
    const refused = await chat('package-chat-registered', false);
    expect(refused.response).toMatchObject({ proposal: { status: 'rejected', reason: 'WORKER_TREE_SECRET_REFUSED' }, run: null });
    expect(refused.events.some(event => event.kind === 'approval.requested')).toBe(false);
    expect(await f.store.loadRun(scopeId, 'package-chat-registered')).toBeNull();
    expect(JSON.stringify([refused, await f.audit(), await packageApprovals(f)])).not.toContain(payload);
  } finally { f.store.close(); }
});

async function expectPrivatePackageRefusal(f: PackageFixture, result: Promise<unknown>, value = payload) {
  const refusal = await result.then(() => null, (error: unknown) => error);
  expect(JSON.stringify([String(refusal), refusal, await f.audit(), f.text, await packageApprovals(f)]).includes(value)).toBe(false);
  expect(refusal).toMatchObject({ code: 'WORKER_TREE_SECRET_REFUSED', params: { paths: expect.stringContaining('node_modules/pkg/check.js (known-secret)') } });
}

it.skipIf(process.platform !== 'linux').each(['list production', 'standalone preview', 'Run card'] as const)(
  'per-Run packages refuse an unreferenced registered value at %s', async boundary => {
    const f = await fixture('current-source', true);
    try {
      await committedPackageVersions(f.root);
      await registerPackageValue(f);
      const actions = {
        'list production': () => produceConfiguredNativeInputs(f.root, scopeId, f.options),
        'standalone preview': () => inspectConfiguredNativeInputs(f.root, scopeId, f.options),
        'Run card': () => f.run('registered-before-card'),
      };
      await expectPrivatePackageRefusal(f, actions[boundary]());
    } finally { f.store.close(); }
  });

it.skipIf(process.platform !== 'linux')('per-Run sealing refuses a value registered after the Run card was approved', async () => {
  const f = await fixture('current-source', true);
  const prepare = RunCreationAuthority.prototype.prepare;
  try {
    await committedPackageVersions(f.root);
    const runId = 'registered-before-sealing';
    await approvePackageRun(f, runId);
    vi.spyOn(RunCreationAuthority.prototype, 'prepare').mockImplementationOnce(async function (this: RunCreationAuthority, ...args) {
      const admitted = await prepare.apply(this, args);
      await registerPackageValue(f);
      return admitted;
    });
    await expectPrivatePackageRefusal(f, f.run(runId));
    expect(await f.store.loadRunReceipt(scopeId, runId)).toBeNull();
  } finally {
    vi.restoreAllMocks();
    f.store.close();
  }
});

async function expectPerRunOpeningRefused(value: string) {
  const f = await fixture('current-source', true);
  try {
    await committedPackageVersions(f.root, '// ' + value + '\n');
    const runId = 'registered-before-opening';
    await approvePackageRun(f, runId);
    await f.run(runId);
    const { reference, profile } = await f.read(runId);
    expect(reference.allowance).toBeUndefined();
    const run = (await f.store.loadRun(scopeId, runId))!;
    const identity = { ...run.identity, taskId: 't', attemptId: 'fixture-opening', generation: 1 };
    const { principal: { id, issuer, subject } } = await f.context();
    await f.store.reserveRunTasks({ commandId: 'fixture-reserve', actor: { id, issuer, subject }, scopeId, runId, expectedRevision: run.revision, now: Date.now(), identities: [identity] });
    await registerPackageValue(f, value);
    const { binding } = resolveNativeCliWorkerProfile(profile), agent = nativeCliAgent(binding.protocolFamily)!;
    const seal = { schemaVersion: 1 as const, capability: 'NativeAgentExecution' as const, executable: binding.definition.executable,
      cliVersion: '2.1.317', ownerUid: userInfo().uid, profileDigest: binding.profileDigest, flagSetDigest: nativeAgentFlagSetDigest(agent) };
    const checkEnvironment = vi.fn(async () => { throw ErrorRegistry.createError('NATIVE_WORKER_LOCKFILE_CHANGED'); });
    const openTools = vi.fn(async () => { throw Error('fixture reached worker opening'); });
    const ports = { readiness: async () => ({ state: 'ready' as const, execution: seal }), f08: async () => seal, recheck: async () => {},
      capacity: { acquire: async () => ({ state: 'acquired' as const, release: async () => {} }) }, checkEnvironment, openTools,
      driver: async () => { throw Error('fixture reached worker driver'); },
      bridgeLimits: { idleMs: 1000, maxConnections: 2, replayMaxEntries: 2, replayMaxBytes: agent.bridge.frameMaxBytes * 2 } };
    const execution = executeConfiguredTask(f.root, identity, { ...f.options, nativeCliWorker: { ports, projectionRetired: true } }).finally(() => {
      const preflight = checkEnvironment.mock.calls.length, tools = openTools.mock.calls.length;
      if (preflight || tools) console.log(JSON.stringify({ preflight, tools }));
    });
    await expectPrivatePackageRefusal(f, execution, value);
    expect(checkEnvironment).not.toHaveBeenCalled();
    expect(openTools).not.toHaveBeenCalled();
    expect(await f.store.loadBoundDispatch(identity)).toBeNull();
    expect((await f.audit()).some(({ event: { subject } }) => subject.kind === 'worker-tree-refused'
      && subject.findings.some(({ path, rule }) => path === 'node_modules/pkg/check.js' && rule === 'known-secret'))).toBe(true);
  } finally { f.store.close(); }
}

// An unreferenced five-unit store value only present in package file contents.
const shortPackageValue = String.fromCharCode(0x2603, 0x2604, 0x2605, 0x2606, 0x2607);
it.skipIf(process.platform !== 'linux').each([payload, shortPackageValue])('per-Run Attempt refuses a registered value before worker delivery (%#)', expectPerRunOpeningRefused);

it.skipIf(process.platform !== 'linux')('refuses a short registered value before either approval path shows the package', async () => {
  const f = await fixture('current-source', true);
  try {
    await committedPackageVersions(f.root, '// ' + shortPackageValue + '\n');
    await registerPackageValue(f, shortPackageValue);
    await expectPrivatePackageRefusal(f, f.run('short-value-before-card'), shortPackageValue);
    await expectPrivatePackageRefusal(f, f.change('grant'), shortPackageValue);
    expect(f.text).toEqual([]);
    expect(await packageApprovals(f)).toEqual([]);
  } finally { f.store.close(); }
});

it.skipIf(process.platform !== 'linux')('refuses a short value registered after reusable approval before worker delivery', async () => {
  const f = await fixture('current-source', true);
  try {
    await committedPackageVersions(f.root, '// ' + shortPackageValue + '\n');
    await f.change('grant');
    await f.run('short-value-reusable-open');
    await registerPackageValue(f, shortPackageValue, false);
    const handover = vi.fn(async () => null);
    await expectPrivatePackageRefusal(f, f.use('short-value-reusable-open', 'open', handover), shortPackageValue);
    expect(handover).not.toHaveBeenCalled();
  } finally { f.store.close(); }
});

async function switchPackageStore(f: PackageFixture) {
  const switched = await executeConfiguredRuntimeSecretOperation(f.root, { schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId: 'package-fixture-switch',
    operation: 'switchSecretStore', delivery: { maxResultBytes: 4096 }, input: { schemaVersion: 1, scopeId, to: ENCRYPTED_FILE_SECRET_STORE_ID, confirmDowngrade: false } },
  { pid: process.pid, uid: userInfo().uid, gid: userInfo().gid, assurance: 'linux-so-peercred' }, 4096, f.options);
  expect(switched).toMatchObject({ status: 'switched', from: FILE_SECRET_STORE_ID, to: ENCRYPTED_FILE_SECRET_STORE_ID, entries: 1, cleaned: true });
}

it.skipIf(process.platform !== 'linux').each(['list production', 'standalone preview', 'Run card', 'reusable card'] as const)(
  'refuses %s from a context loaded before a managed store switch', async boundary => {
    const f = await fixture('current-source', true);
    try {
      await committedPackageVersions(f.root);
      await registerPackageValue(f);
      const listPath = join(f.root, 'deckent-package-files.json'), sentinel = 'fixture list must stay unchanged';
      await writeFile(listPath, sentinel);
      hooks.afterScopeLoad = () => switchPackageStore(f);
      const actions = {
        'list production': () => produceConfiguredNativeInputs(f.root, scopeId, f.options),
        'standalone preview': () => inspectConfiguredNativeInputs(f.root, scopeId, f.options),
        'Run card': () => f.run('stale-store-before-card'),
        'reusable card': () => f.change('grant'),
      };
      const refusal = await actions[boundary]().then(() => null, (error: unknown) => error);
      expect(await readFile(listPath, 'utf8')).toBe(sentinel);
      expect(f.text).toEqual([]);
      expect(await packageApprovals(f)).toEqual([]);
      expect((await f.context()).config['secrets']).toEqual({ store: ENCRYPTED_FILE_SECRET_STORE_ID });
      expect(JSON.stringify([String(refusal), refusal, await f.audit()]).includes(payload)).toBe(false);
      expect(refusal).toMatchObject({ code: 'NATIVE_WORKER_DEPENDENCIES_REFUSED' });
    } finally { f.store.close(); }
  });

it.skipIf(process.platform !== 'linux')('refuses a Run card when the managed store switches after a clean package scan', async () => {
  const f = await fixture('current-source', true);
  try {
    await committedPackageVersions(f.root);
    await registerPackageValue(f, 'unrelated-fixture-value');
    let custodyRequests = 0;
    hooks.lock = async (path, phase) => {
      if (path === f.globalPath + '.secret-custody' && phase === 'request' && ++custodyRequests === 2) {
        hooks.lock = undefined;
        await switchPackageStore(f);
      }
    };
    await expect(f.run('store-switch-after-package-scan')).rejects.toMatchObject({ code: 'NATIVE_WORKER_DEPENDENCIES_REFUSED' });
    expect(custodyRequests).toBe(2);
    expect(await packageApprovals(f)).toEqual([]);
  } finally { f.store.close(); }
});

it.skipIf(process.platform !== 'linux')('releases secret custody while the person considers a reusable package card', async () => {
  const f = await fixture('current-source', true);
  try {
    await committedPackageVersions(f.root);
    await registerPackageValue(f, 'unrelated-fixture-value');
    const confirm = vi.fn(async () => { await switchPackageStore(f); return false; });
    await expect(changeConfiguredPackageAllowance(f.root, { action: 'grant', scopeId, kind, locale: 'en' }, f.options, confirm))
      .resolves.toEqual({ status: 'declined' });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(await packageApprovals(f)).toEqual([]);
  } finally { f.store.close(); }
});

it.skipIf(process.platform !== 'linux').each([
  ['withdraw', 'en'], ['withdraw', 'tr'], ['retire', 'en'], ['retire', 'tr'],
] as const)('late grant replay after %s renders the historical decision in %s', async (end, locale) => {
  const f = await fixture('current-source');
  try {
    const revisions = await committedPackageVersions(f.root), commandId = randomUUID(), runId = 'late-grant-replay';
    const output: string[] = [];
    let decision: Awaited<ReturnType<typeof f.change>> | undefined;
    const handover = vi.fn(async () => {});
    const stdout = { isTTY: true, write(value: string) { output.push(value); } };
    const cli = () => codingCommand(['coding', 'template', '--allow-dependencies', '--kind', kind, '--scope', scopeId, '--command-id', commandId, '--lang', locale], {
      root: f.root, env: f.options.env, stdin: Object.assign(new PassThrough(), { isTTY: true }), stdout,
      configureCodingTemplate: async () => { throw Error('fixture reached template setup'); },
      changeCodingAllowance: (root, request, options) => changeConfiguredPackageAllowance(root, request, options, async () => {
        decision = await f.change('grant', commandId);
        await f.run(runId);
        if (end === 'withdraw') await f.change('withdraw');
        else {
          revisions.select(revisions.listChanged);
          await expect(f.use(runId, 'open', handover)).rejects.toMatchObject({ code: 'NATIVE_WORKER_DEPENDENCIES_REFUSED' });
          revisions.select(revisions.approved);
        }
        return true;
      }),
    });
    await cli();
    await expect(f.use(runId, 'open', handover)).rejects.toMatchObject({ code: 'NATIVE_WORKER_DEPENDENCIES_REFUSED' });
    expect(handover).not.toHaveBeenCalled();
    if (decision?.status !== 'active') throw Error('fixture failed to publish the winning grant');
    const { decisionId, version } = decision;
    expect(output.join('').trim()).toBe(locale === 'en' ? `Recorded package decision ${decisionId} · version ${version} · inactive.`
      : `Kayıtlı paket kararı ${decisionId} · sürüm ${version} · etkin değil.`);
  } finally { f.store.close(); }
});

it.skipIf(process.platform !== 'linux').each(['write intent', 'grant publication'] as const)(
  'the built CLI recovers an exact witnessed grant after SIGKILL at %s', async boundary => {
    const f = await fixture('current-source');
    try {
      await committedPackageVersions(f.root);
      const commandId = randomUUID();
      const argv = ['coding', 'template', '--allow-dependencies', '--kind', kind, '--scope', scopeId, '--command-id', commandId, '--lang', 'en'];
      const env = { ...f.options.env, PATH: process.env.PATH, TERM: 'xterm', NO_COLOR: '1' };
      const pty = openPtySession([process.execPath, ...crashProbe(boundary, f.root, ...argv)], process.cwd(), env);
      try {
        await pty.waitFor('Approve this package version for reuse', 0, 15_000);
        const preview = pty.text();
        for (const item of ['pkg/check.js', 'pkg/package.json', 'pattern:url-userinfo', 'unregistered real secret'])
          expect(preview).toContain(item);
        expect(preview).not.toContain(payload);
        await pty.type('y');
        await pty.waitFor('reached ' + boundary, 0, 15_000);
        expect(await pty.closed).toBe(247); // The PTY relay encodes the child's -SIGKILL exit as an unsigned byte.
      } finally { await pty.close(); }
      const changed = JSON.parse(await readFile(f.configPath, 'utf8')).toolchains?.packageAllowances;
      if (boundary === 'write intent') expect(changed).toBeUndefined();
      else expect(changed).toMatchObject([{ generation: commandId, version: 1 }]);
      const events = () => f.audit();
      const writeIntent = ({ event: { subject } }: Awaited<ReturnType<typeof events>>[number]) =>
        subject.kind === 'config-change' && subject.keyPath === WORKER_PACKAGE_ALLOWANCE_KEY && subject.commandId === commandId;
      const [intent] = (await events()).filter(writeIntent);
      expect(intent?.event.subject).toMatchObject({ approvalId: expect.any(String) });
      const subject = intent?.event.subject;
      if (subject?.kind !== 'config-change' || !subject.approvalId) throw Error('missing grant intent');
      const retry = await f.change('grant', commandId);
      expect(retry).toMatchObject({ status: 'active', version: 1, decisionId: subject.approvalId });
      if (boundary === 'grant publication') expect(changed[0].decisionId).toBe(subject.approvalId);
      expect((await events()).filter(writeIntent)).toHaveLength(1);
      expect((await events()).filter(({ event: { subject } }) => subject.kind === 'authority-decision'
        && subject.action === 'package-grant' && subject.envelope.commandId === commandId)).toHaveLength(1);
      expect(await f.run('after-interruption')).toMatchObject({ run: { runId: 'after-interruption' } });
    } finally { f.store.close(); }
  }, 45_000);

it.skipIf(process.platform !== 'linux').each(['listChanged', 'lockChanged'] as const)(
  'current committed source retires a generation for %s after an interrupted append', async version => {
    const f = await fixture('current-source');
    try {
      const revisions = await committedPackageVersions(f.root);
      const grant = await f.change('grant');
      expect(f.text.join('\n')).toContain('pattern:url-userinfo');
      await f.run('approved-run');
      const initial = await inspectConfiguredNativeInputs(f.root, scopeId, f.options, 'approved-run');
      const { reference } = await f.read('approved-run');
      const retirements = async () => (await f.audit()).filter(({ event: { subject } }) =>
        subject.kind === 'authority-decision' && subject.action === 'package-retire');
      const history = () => inspectConfiguredNativeInputs(f.root, scopeId, f.options, 'approved-run');
      const handover = vi.fn(async () => 'handed over');
      await expect(f.run('old-pin', undefined, revisions[version])).rejects.toMatchObject({ code: 'NATIVE_WORKER_DEPENDENCIES_REFUSED' });
      expect(await f.store.loadRunReceipt(scopeId, 'old-pin')).toBeNull();
      expect(await retirements()).toHaveLength(0);
      await expect(f.use('approved-run', 'open', handover)).resolves.toBe('handed over');
      handover.mockClear();

      revisions.select(revisions[version]);
      const changed = await inspectConfiguredNativeInputs(f.root, scopeId, f.options);
      if (changed.kind !== 'prepared') throw Error('missing verified current input');
      if (version === 'listChanged') {
        expect(changed.lockfileDigest).toBe(reference.lockfileDigest);
        expect(changed.listDigest).not.toBe(reference.listDigest);
        expect(changed.manifest.entries.flatMap(row => row.rules)).not.toContain('pattern:url-userinfo');
      } else {
        expect(changed.lockfileDigest).not.toBe(reference.lockfileDigest);
        expect(changed.listDigest).toBe(reference.listDigest);
      }
      const child = spawnSync(process.execPath, crashProbe('retirement append', f.root), {
        input: JSON.stringify({ scopeId, options: f.options, binding: await f.read('approved-run') }),
        env: { ...f.options.env, PATH: process.env.PATH }, encoding: 'utf8', timeout: 12_000,
      });
      expect({ status: child.status, signal: child.signal, stdout: child.stdout.trim() }, child.stderr)
        .toEqual({ status: null, signal: 'SIGKILL', stdout: 'reached retirement append' });
      console.log(JSON.stringify({ status: child.status, signal: child.signal, boundary: child.stdout.trim() }));
      expect(handover).not.toHaveBeenCalled();
      expect(await retirements()).toHaveLength(0);

      await expect(f.use('approved-run', 'open', handover)).rejects.toMatchObject({ code: 'NATIVE_WORKER_DEPENDENCIES_REFUSED' });
      const events = await retirements();
      expect(events).toHaveLength(1);
      expect(events[0]!.event.subject).toMatchObject({ action: 'package-retire', resource: { id: reference.allowance!.partition },
        basisDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) });
      expect(await f.store.loadRunReceipt(scopeId, 'approved-run')).not.toBeNull();
      expect(initial.kind).toBe('run');
      if (initial.kind !== 'run') throw Error('missing historical Run');
      expect(await history()).toMatchObject({ kind: 'run', rows: [{ decision: { ...initial.rows[0]!.decision,
        retirement: { reason: 'version-changed', at: events[0]!.event.atMs } } }] });
      expect(grant).toMatchObject({ status: 'active', version: 1 });
      expect(initial.rows[0]!.decision).toMatchObject({ version: 1, person: readLocalOsIdentity().id, decidedAt: expect.any(Number) });
      expect(initial.rows[0]!.decision).not.toHaveProperty('retirement');
      revisions.select(revisions.approved);
      await expect(f.use('approved-run', 'open', handover)).rejects.toMatchObject({ code: 'NATIVE_WORKER_DEPENDENCIES_REFUSED' });
      await expect(f.run('old-content-returned')).rejects.toMatchObject({ code: 'NATIVE_WORKER_DEPENDENCIES_REFUSED' });
      expect(await f.store.loadRunReceipt(scopeId, 'old-content-returned')).toBeNull();
      expect(handover).not.toHaveBeenCalled();
      expect(await retirements()).toHaveLength(1);
      expect(await f.change('grant')).toMatchObject({ status: 'active', version: 2 });
      await expect(f.run('new-person-decision')).resolves.toMatchObject({ run: { runId: 'new-person-decision' } });
      console.log(JSON.stringify({ version, mismatchedPinnedRun: 'refused; allowance active', interruptedAppend: 'no handover or retirement',
        retirementSequence: events[0]!.sequence, returnToOldContent: 'refused until new person decision' }));
    } finally { f.store.close(); }
  }, 20_000);
