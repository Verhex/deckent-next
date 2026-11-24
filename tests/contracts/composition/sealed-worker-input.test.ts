import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeCodingTemplate, compileNativeCodingWorkInput, nativeCliAgent, readLocalOsIdentity, resolveNativeCliWorkerProfile, sealedWorkerTreeLocation, withMcpPrincipal } from '#adapters/index.js';
import { inspectSealedWorkerTree, reviewSealedWorkerTree, sealWorkerTree } from '#adapters/core/worker-tree-gate/index.js';
import { approvalRecordSchema } from '#domain/index.js';
import { DispatchPolicyAuthorization, FILE_SECRET_STORE_ID, RUNTIME_SERVICE_SCHEMA_VERSION, RunAdmissionApplication, RunCreationAuthority, verifiedPrincipal } from '#engine/index.js';
import { EMPTY_KNOWN_SECRETS, ErrorRegistry, getConfigKnownSecrets, knownSecretValues, loadConfig, prepareProductDirectory, productResourcePath, resolveGlobalConfigPaths, resolveProductLayout, sha256, withConfigWriteLock, WORKER_PACKAGE_ALLOWANCE_KEY, type DeckentConfig } from '#platform/index.js';
import { nativeAgentFlagSetDigest } from '#adapters/core/native-cli-headless/index.js';
import { codingCommand } from '#surfaces/core/cli-admin/index.js';
import { createConfiguredConfigApplication } from '#composition/core/config/index.js';
import { executeConfiguredTask } from '#composition/core/execution/index.js';
import { configuredApproval } from '#composition/core/approvals/index.js';
import { contextPolicySource } from '#composition/core/policy/index.js';
import { composeCore } from '#composition/core/root/index.js';
import { loadConfiguredScopeContext, withScopeAudit } from '#composition/core/scoped-request/index.js';
import { changeConfiguredPackageAllowance, withPackageUse } from '#composition/core/workspace-patch/index.js';
import { inspectConfiguredNativeInputs, produceConfiguredNativeInputs } from '#composition/core/runs/index.js';
// eslint-disable-next-line no-restricted-imports -- Exercise the producer and last-boundary Run seams without exporting a fixture mode.
import { nativeInputAdmission } from '../../../src/composition/core/runs/internal/native-inputs.js';
// eslint-disable-next-line no-restricted-imports -- The application reuses the real ledger audit and approval integrity custody.
import { withRunCreationAuthority } from '../../../src/composition/core/runs/internal/authority.js';
// eslint-disable-next-line no-restricted-imports -- Check exact publication/withdrawal evidence in the audit.
import { packageActivity, packageIntentId } from '../../../src/composition/core/workspace-patch/internal/package-activity.js';
// eslint-disable-next-line no-restricted-imports -- Open the real Attempt input boundary on a disposable checkout.
import { openSealedNativeInput } from '../../../src/composition/core/execution/internal/sealed-input.js';
// eslint-disable-next-line no-restricted-imports -- Use the configured secret command writer without starting a service.
import { executeConfiguredRuntimeSecretOperation } from '../../../src/composition/core/runtime-service/internal/secret.js';
// eslint-disable-next-line no-restricted-imports -- Exercise both production input-floor entries without expanding the composition API.
import { prepareNativeWorkerInputs } from '../../../src/composition/core/execution/internal/worker-inputs.js';

import { openConfiguredAttemptStore } from '../support/configured-open.js';
import { fixtureExecution } from '../support/execution-registry.js';
import { openPtySession } from '../support/pty-session.js';

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
vi.mock('../../../src/composition/core/workspace-patch/internal/prepared-input.js', async load => {
  const actual = await load<typeof import('../../../src/composition/core/workspace-patch/internal/prepared-input.js')>();
  return { ...actual, configuredPreparedInput: (...args: Parameters<typeof actual.configuredPreparedInput>) => hooks.prepared ?? actual.configuredPreparedInput(...args) };
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

async function fixture(mode?: 'writers' | 'current-source', useFileStore = mode === 'writers') {
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
      rule('secret-register', 'secret', ['set']),
      rule('admin', 'operation', ['execute'], [proxyAdmin], ['policy.administer']),
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
    assertCurrent: async () => {},
    review: () => reviewSealedWorkerTree(source, 'node_modules', gate, known()), seal: (reference: Parameters<typeof sealedWorkerTreeLocation>[1]) =>
      sealWorkerTree(source, sealedWorkerTreeLocation(artifacts, reference), 'node_modules', reference.listDigest, gate, known(), undefined, {
        run: (key, work) => withConfigWriteLock(key, work, gate.timeoutMs), maxBytes: async () => config.installation.sealedPackageStoreMaxBytes,
      }) };
  const context = () => loadConfiguredScopeContext(root, scopeId, { ...options, force: true }, 'write');
  const run = async (runId: string, beforeCommit?: () => Promise<void>, baseRevision?: string) => {
    const ctx = await context();
    const persistence = {
      loadRunReceipt: store.loadRunReceipt.bind(store), loadRunWorkspaceCustody: store.loadRunWorkspaceCustody.bind(store),
      async createRun(...args: Parameters<typeof store.createRun>) { await beforeCommit?.(); return store.createRun(...args); },
    };
    return withRunCreationAuthority(ctx, authority => new RunAdmissionApplication(persistence, verifiedPrincipal(ctx.principal), authority, { authorize: async () => {} }, {
      inputs: nativeInputAdmission(root, ctx, options),
      async resolve() { const execution = fixtureExecution(graph);
        return { now: Date.now(), layoutRevision: ctx.layout.revision, execution: { ...execution, tasks: execution.tasks.map(task => ({ ...task, profile: compiled })) },
          policy: { schemaVersion: 2, poolId: 'pool', capacity: { executionSlots: 2, inFlightSlots: 2 }, ordering: ['t'] } }; },
    }).create(command(runId), undefined, baseRevision ? async () => ({ schemaVersion: 1, scopeId, runId, baseRevision,
      source: { schemaVersion: 1, adapter: { id: 'git', version: 1 }, sourceFingerprint: 'c'.repeat(64) } }) : undefined));
  };
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
  return { artifact: sealedWorkerTreeLocation, artifacts, root, source, checkout, config, configPath, globalPath, options, store, policy, text, run, change, read, use, audit, context, opened };
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

async function committedPackageVersions(root: string) {
  const source = join(root, 'node_modules', 'pkg'), archive = join(root, 'package'), tarball = join(root, 'fixture.tgz');
  await mkdir(source, { recursive: true });
  await mkdir(archive);
  const files = { 'package.json': '{"name":"pkg","version":"1.0.0"}', 'check.js': `// https://${payload}@example.invalid\n` };
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
async function registerPackageValue(f: PackageFixture) {
  await executeConfiguredRuntimeSecretOperation(f.root, { schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId: 'per-run-fixture-secret',
    operation: 'setSecret', delivery: { maxResultBytes: 4096 }, input: { schemaVersion: 1, scopeId, name: 'PACKAGE_FIXTURE', value: payload } },
  { pid: process.pid, uid: userInfo().uid, gid: userInfo().gid, assurance: 'linux-so-peercred' }, 4096, f.options);
  const { config } = await f.context();
  expect(getConfigKnownSecrets(config).spans(payload)).toHaveLength(0);
  expect(config.toolchains.packageAllowances).toBeUndefined();
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

async function expectPrivatePackageRefusal(f: PackageFixture, result: Promise<unknown>) {
  const refusal = await result.then(() => null, (error: unknown) => error);
  expect(JSON.stringify([String(refusal), refusal, await f.audit(), f.text]).includes(payload)).toBe(false);
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

it.skipIf(process.platform !== 'linux')('per-Run Attempt refuses a value registered after sealing, before worker delivery', async () => {
  const f = await fixture('current-source', true);
  try {
    await committedPackageVersions(f.root);
    const runId = 'registered-before-opening';
    await approvePackageRun(f, runId);
    await f.run(runId);
    const { reference, profile } = await f.read(runId);
    expect(reference.allowance).toBeUndefined();
    const run = (await f.store.loadRun(scopeId, runId))!;
    const identity = { ...run.identity, taskId: 't', attemptId: 'fixture-opening', generation: 1 };
    const { principal: { id, issuer, subject } } = await f.context();
    await f.store.reserveRunTasks({ commandId: 'fixture-reserve', actor: { id, issuer, subject }, scopeId, runId, expectedRevision: run.revision, now: Date.now(), identities: [identity] });
    await registerPackageValue(f);
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
    await expectPrivatePackageRefusal(f, execution);
    expect(checkEnvironment).not.toHaveBeenCalled();
    expect(openTools).not.toHaveBeenCalled();
    expect(await f.store.loadBoundDispatch(identity)).toBeNull();
    expect((await f.audit()).some(({ event: { subject } }) => subject.kind === 'worker-tree-refused'
      && subject.findings.some(({ path, rule }) => path === 'node_modules/pkg/check.js' && rule === 'known-secret'))).toBe(true);
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
