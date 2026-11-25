import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, expect, it, vi } from 'vitest';
import * as adapters from '#adapters/index.js';
import { mcpApplications } from '#composition/core/mcp/index.js';
import { applyConfiguredRunLifecycle } from '#composition/core/runs/index.js';
import { createRun, holdRun, mcpPrincipalRef } from '#domain/index.js';
import { AttemptStoreError, AuthenticationError, RunDecisionApprovalBroker } from '#engine/index.js';
import { createMcpServer } from '#surfaces/core/mcp/index.js';
import { isCodedError, productResourcePath, t, withConfigWriteLock, type Locale } from '#platform/index.js';
import { openConfiguredAttemptStore } from '../support/configured-open.js';
import { fixtureExecution } from '../support/execution-registry.js';
const machine = vi.hoisted(() => ({ absent: false }));
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, readFile: (...args: Parameters<typeof original.readFile>) =>
    machine.absent && args[0] === '/etc/machine-id' ? Promise.reject(Object.assign(new Error('fixture machine id missing'), { code: 'ENOENT' })) : original.readFile(...args) };
});
it('exposes policy-gated hold/resume through one command contract and refuses human answers at the MCP wire', async () => {
  const received: unknown[] = [];
  const server = createMcpServer({ async inspectRun() { return {}; }, async inspectInventory() { return {}; },
    async applyRunControl(command) { received.push(command); return { command }; } }, { maxConcurrentCalls: 2, responseMaxBytes: 8192 }, 'en');
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st);
  const client = new Client({ name: 'input-hold-test', version: '1' }); await client.connect(ct);
  try {
    const tools = (await client.listTools()).tools;
    expect(tools.find(tool => tool.name === 'control_run')!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
    expect(tools.some(tool => /answer|accept|decide/.test(tool.name))).toBe(false);
    // Ek A: one object at the schema root, so a client that keeps a single root variant still sees both actions.
    const schema = tools.find(tool => tool.name === 'control_run')!.inputSchema as { anyOf?: unknown; properties: Record<string, { enum?: unknown[] }>; required: string[] };
    expect(schema.anyOf).toBeUndefined(); expect(schema.properties['action']!.enum).toEqual(['hold', 'resume']);
    expect(schema.required).not.toContain('holdReason'); expect(Object.keys(schema.properties)).toContain('holdReason');
    const base = { schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'hold', expectedRevision: 0 };
    expect((await client.callTool({ name: 'control_run', arguments: { ...base, action: 'hold', holdReason: 'Wait' } })).isError).not.toBe(true);
    expect((await client.callTool({ name: 'control_run', arguments: { ...base, action: 'resume', commandId: 'resume', expectedRevision: 1 } })).isError).not.toBe(true);
    for (const invalid of [{ action: 'answer', taskId: 't', answer: 'EU' }, { action: 'accept', taskId: 't' }, { action: 'hold', holdReason: 'Wait', principal: 'owner' },
      { action: 'resume', answer: 'EU', taskId: 't' }, { action: 'hold', holdReason: '' }]) {
      expect(JSON.stringify(await client.callTool({ name: 'control_run', arguments: { ...base, ...invalid } }))).toContain('MCP_INPUT_INVALID');
    }
    // Ek A: the refusal carries the installation-language catalog message beside the code (never the zod text with submitted values).
    const refused = JSON.parse(((await client.callTool({ name: 'control_run', arguments: { ...base, action: 'resume', answer: 'EU' } })).content as { text: string }[])[0]!.text);
    expect(refused).toEqual({ schemaVersion: 1, code: 'MCP_INPUT_INVALID', message: t('error.MCP_INPUT_INVALID', {}, 'en') });
    expect(received).toHaveLength(2);
  } finally { await client.close(); await server.close(); }
});

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it.skipIf(process.platform === 'win32')('projects configured Run control disclosure and concealment through the full MCP response', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-mcp-control-')); roots.push(root);
  const data = join(root, 'data'), home = join(root, 'home'), options = { env: { HOME: home, USERPROFILE: home } };
  const installation = { machineIdentity: { source: join(root, 'machine-id') } };
  await writeFile(installation.machineIdentity.source, 'mcp-control-fixture-host', { mode: 0o600 });
  await mkdir(join(root, '.deckent'), { mode: 0o700 });
  const configure = (dataRoot: string, resources = {}, settings: { machineIdentity?: typeof installation.machineIdentity; requireMachineBinding?: boolean } = installation) => writeFile(join(root, '.deckent/config.json'),
    JSON.stringify({ layout: { root: dataRoot, resources }, installation: settings }), { mode: 0o600 });
  await configure(data);
  const { store, layout, path } = await openConfiguredAttemptStore(root, options);
  const owner = adapters.readLocalOsIdentity(), actor = mcpPrincipalRef(owner), scopeId = 's';
  const graph = { schemaVersion: 2, revision: 1, tasks: [{ id: 't', kind: 'fixture', dependencies: [], acceptanceCriteria: ['ok'] }],
    criterionDefinitions: [{ id: 'ok', version: 1, description: 'ok', evaluator: { id: 'test', version: 1 }, parameters: {} }] };
  const now = Date.now(), capacity = { executionSlots: 1, inFlightSlots: 1 };
  try {
    await store.createExecutionPool({ schemaVersion: 1, poolId: 'pool', capacity });
    for (const [runId, source] of [['operator', 'operator'], ['safety', 'nervous'], ['corrupt', 'operator'], ['fresh', null],
      ['drift', null], ['policy-race', null], ['race-hidden', 'operator'], ['race-visible', 'operator'],
      ['layout-edit', null], ['policy-edit', null], ['busy-visible', null], ['busy-hidden', null], ['identity-first', null], ['identity-weak', null]] as const) {
      const identity = { scopeId, runId, layoutRevision: 'fixture' }, execution = fixtureExecution(graph);
      await store.createRun({ commandId: `create-${runId}`, actor: { id: owner.id, issuer: owner.issuer, subject: owner.subject },
        identity, graph, execution, now, policy: { schemaVersion: 2, poolId: 'pool', capacity, ordering: ['t'] } });
      if (!source) continue;
      const held = holdRun(createRun(identity, graph, now, execution), 0, 'private hold note', now, 60_000, source);
      const db = new DatabaseSync(path);
      try { db.prepare('UPDATE runs SET revision=?,snapshot=? WHERE scope_id=? AND run_id=?')
        .run(held.revision, runId === 'corrupt' ? '{}' : JSON.stringify(held), scopeId, runId); } finally { db.close(); }
    }
  } finally { store.close(); }
  adapters.registerLedgerScopes(path, { busyTimeoutMs: 1000, journalMode: 'wal', durability: 'full' }, 'foreign-company', ['foreign']);
  const grant = (id: string, kind: string, actions: string[], scopes: string[], ids: 'all' | string[] = 'all') =>
    ({ id, effect: 'allow', actions, scopes, principals: [actor], resource: { kind, ids } });
  const policyPath = productResourcePath(layout, 'policy');
  const writePolicy = (policyFile: string, revision: string, ...grants: ReturnType<typeof grant>[]) => writeFile(policyFile, JSON.stringify({ schemaVersion: 1, revision,
    restrictions: [], grants: [grant('scope', 'scope', ['inspect'], [scopeId, 'foreign']), ...grants] }), { mode: 0o600 });
  const setPolicy = (...grants: ReturnType<typeof grant>[]) => writePolicy(policyPath, 'fixture', ...grants);
  const runGrant = (...actions: string[]) => grant('control', 'run', actions, [scopeId]);
  const delegated = grant('delegate-resume', 'run-decision', ['resume'], [scopeId]);
  const inspectAbsent = grant('inspect-absent', 'run', ['inspect'], [scopeId], ['absent']);
  const openReader = adapters.openSqliteInventoryReader;
  const lookup = vi.fn(), receiptRead = vi.fn();
  let readFailure = false;
  vi.spyOn(adapters, 'openSqliteInventoryReader').mockImplementation(async (...args) => {
    const reader = await openReader(...args), load = reader.loadRun.bind(reader), receipt = reader.loadRunReceipt.bind(reader);
    vi.spyOn(reader, 'loadRun').mockImplementation(async (...key) => {
      await lookup(...key);
      if (readFailure) throw new AttemptStoreError('ATTEMPT_STORE_READ_UNAVAILABLE');
      return load(...key);
    });
    vi.spyOn(reader, 'loadRunReceipt').mockImplementation(async (...key) => { receiptRead(...key); return receipt(...key); });
    return reader;
  });
  const identity = vi.spyOn(adapters, 'readLocalOsIdentity');
  const installWrite = vi.spyOn(adapters.FileInstallationIdentityStore.prototype, 'loadOrCreate');
  const projectWrite = vi.spyOn(adapters.FileProjectIdentityStore.prototype, 'loadOrCreate');
  const keyOpen = vi.spyOn(adapters, 'openLocalIntegrityAuthority');
  const approvalOpen = vi.spyOn(adapters, 'openSqliteApprovalStore');
  const state = (ledger = path) => {
    const db = new DatabaseSync(ledger, { readOnly: true });
    try {
      return ['runs', 'run_receipts', 'approvals', 'approval_receipts', 'approval_outbox', 'audit_events', 'scope_registry']
        .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    } finally { db.close(); }
  };
  const effects = () => [state(), installWrite.mock.calls.length, projectWrite.mock.calls.length,
    keyOpen.mock.calls.filter(([, , create]) => create).length, approvalOpen.mock.calls.length];
  const command = { schemaVersion: 1, scopeId, runId: 'absent', action: 'resume', commandId: 'resume', expectedRevision: 1 };
  const published = (response: Awaited<ReturnType<Client['callTool']>>, code: string, locale?: Locale, params = {}) => {
    const body = { schemaVersion: 1, code, ...(locale ? { message: t(`error.${code}`, params, locale) } : {}) };
    expect(response).toMatchObject({ isError: true, content: [{ type: 'text', text: JSON.stringify(body) }] });
    expect(response.structuredContent).toBeUndefined();
  };
  for (const [locale, limit] of [['tr', 8192], ['en', 256], ['tr', 256], ['en', 8192]] as const) {
    const server = createMcpServer(mcpApplications({ async inspectRun() { return {}; }, async inspectInventory() { return {}; },
      applyRunControl: input => applyConfiguredRunLifecycle(root, input, options) }), { maxConcurrentCalls: 1, responseMaxBytes: limit }, locale);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'configured-control-test', version: '1' });
    await server.connect(st); await client.connect(ct);
    const call = async (arguments_: Record<string, unknown> = {}, unchanged = true) => {
      const before = effects();
      const response = await client.callTool({ name: 'control_run', arguments: { ...command, ...arguments_ } });
      if (unchanged) expect.soft(effects()).toEqual(before);
      return response;
    };
    try {
      await setPolicy(runGrant('reserve'), inspectAbsent);
      if (limit > 256) {
        published(await call(), 'RUN_NOT_FOUND', locale, { run: 'absent' });
        const lookups = lookup.mock.calls.length, receipts = receiptRead.mock.calls.length;
        identity.mockImplementationOnce(() => { throw new AuthenticationError('AUTHENTICATION_REQUIRED'); });
        published(await call({ runId: 'operator' }), 'AUTHENTICATION_REQUIRED', locale);
        published(await call({ scopeId: 'foreign', runId: 'operator' }), 'SCOPE_UNKNOWN', locale);
        const held = await call({ action: 'hold', holdReason: 'wait', runId: 'operator' });
        published(held, 'POLICY_DENIED', locale);
        expect(await call({ action: 'hold', holdReason: 'wait' })).toEqual(held);
        await setPolicy(runGrant('cancel'));
        const resumeDenied = await call({ runId: 'operator' });
        published(resumeDenied, 'POLICY_DENIED', locale);
        expect(await call()).toEqual(resumeDenied);
        expect(lookup).toHaveBeenCalledTimes(lookups);
        expect(receiptRead).toHaveBeenCalledTimes(receipts);
      }
      await setPolicy(runGrant('reserve'));
      const absent = await call();
      published(absent, 'POLICY_DENIED', limit > 256 ? locale : undefined);
      expect(await call({ runId: 'operator' })).toEqual(absent);
      await setPolicy(runGrant('reserve'), delegated);
      expect(await call()).toEqual(absent);
      expect(await call({ runId: 'safety' })).toEqual(absent);
      expect(await call({ runId: 'operator', expectedRevision: 0 })).toEqual(absent);
      expect(await call({ runId: 'operator', commandId: 'create-safety' })).toEqual(absent);
      if (limit > 256) {
        published(await call({ runId: 'corrupt' }), 'RUN_STORE_CORRUPT', locale);
        readFailure = true;
        try { published(await call(), 'ATTEMPT_STORE_READ_UNAVAILABLE', locale); } finally { readFailure = false; }
        await setPolicy(runGrant('reserve'), grant('inspect-other', 'run', ['inspect'], [scopeId], ['operator']));
        expect(await call()).toEqual(absent);
      }
      if (limit === 8192) {
        for (const visible of [true, false]) {
          await setPolicy(visible ? runGrant('cancel', 'inspect') : runGrant('cancel'));
          await withConfigWriteLock(policyPath, async () => {
            const runId = visible ? 'busy-visible' : 'busy-hidden';
            const locked = await call({ action: 'hold', runId, commandId: runId, expectedRevision: 0, holdReason: 'wait' });
            if (visible) {
              const body = JSON.parse((locked.content as { text: string }[])[0]!.text);
              expect.soft(locked.isError).toBe(true);
              expect.soft(locked.structuredContent).toBeUndefined();
              expect.soft({ ...body, message: body.message?.replace(/(?<=age )\d+(?=s)|(?<=yaş )\d+(?= sn)/g, 'AGE') }).toEqual({
                schemaVersion: 1, code: 'CONFIG_WRITE_LOCKED', message: locale === 'en'
                  ? 'Configuration is locked (age AGEs). Retry after the writer finishes.'
                  : 'Config kilitli (yaş AGE sn). Yazıcı tamamlandıktan sonra yeniden deneyin.' });
            } else expect.soft(locked).toEqual(absent);
          });
        }
      }
      if (locale === 'en' && limit === 8192) {
        await setPolicy(runGrant('cancel', 'reserve'), delegated);
        const hold = { action: 'hold', runId: 'fresh', commandId: 'hold-fresh', expectedRevision: 0, holdReason: 'Release window' };
        const resume = { runId: 'fresh', commandId: 'resume-fresh' };
        const held = await call(hold, false);
        expect(held.isError).not.toBe(true);
        expect(held.structuredContent).toMatchObject({ lifecycle: { commandId: 'hold-fresh', run: { revision: 1 } } });
        const resumed = await call(resume, false);
        expect(resumed.isError).not.toBe(true);
        expect(resumed.structuredContent).toMatchObject({ lifecycle: { commandId: 'resume-fresh', run: { revision: 2 } } });
        expect(await call(resume)).toEqual(resumed);
        expect(approvalOpen).not.toHaveBeenCalled();

        const conflict = { isError: true, content: [{ type: 'text', text: JSON.stringify({ schemaVersion: 1, code: 'RUN_STORE_CONFLICT',
          message: t('error.RUN_STORE_CONFLICT', {}, locale) }) }] };
        await setPolicy(runGrant('reserve', 'inspect'), delegated);
        const stale = await call({ runId: 'operator', expectedRevision: 0 });
        expect.soft(stale).toMatchObject(conflict);
        expect(stale.structuredContent).toBeUndefined();

        const openWriter = adapters.openSqliteAttemptStore;
        for (const [inspect, runId] of [[false, 'race-hidden'], [true, 'race-visible']] as const) {
          await setPolicy(inspect ? runGrant('reserve', 'inspect') : runGrant('reserve'), delegated);
          let afterWinner: ReturnType<typeof state> | undefined;
          const writer = vi.spyOn(adapters, 'openSqliteAttemptStore').mockImplementationOnce(async (...args) => {
            const db = new DatabaseSync(path);
            try { db.prepare("UPDATE runs SET revision=revision+1,snapshot=json_set(snapshot,'$.revision',revision+1) WHERE scope_id=? AND run_id=?").run(scopeId, runId); }
            finally { db.close(); }
            afterWinner = state();
            return openWriter(...args);
          });
          const raced = await call({ runId, commandId: runId }, false);
          expect(writer).toHaveBeenCalledOnce();
          writer.mockRestore();
          expect(state()).toEqual(afterWinner);
          if (inspect) expect(raced).toMatchObject(conflict); else expect(raced).toEqual(absent);
          expect(raced.structuredContent).toBeUndefined();
        }

        const moved = join(root, 'moved');
        await configure(moved);
        const other = await openConfiguredAttemptStore(root, options);
        other.store.close();
        await writePolicy(productResourcePath(other.layout, 'policy'), 'fixture', runGrant('cancel'));
        await configure(data);
        await setPolicy(runGrant('cancel'));
        const before = [effects(), state(other.path)];
        const authorize = RunDecisionApprovalBroker.prototype.authorize;
        const broker = vi.spyOn(RunDecisionApprovalBroker.prototype, 'authorize').mockImplementationOnce(async function (this: RunDecisionApprovalBroker, ...args) {
          const decision = await authorize.apply(this, args);
          await configure(moved);
          return decision;
        });
        try {
          const drifted = await call({ ...hold, runId: 'drift', commandId: 'drift' }, false);
          expect(broker).toHaveBeenCalledOnce();
          expect.soft(drifted).toEqual(absent);
          expect.soft([effects(), state(other.path)]).toEqual(before);
        } finally { broker.mockRestore(); await configure(data); }

        const readProject = adapters.FileProjectIdentityStore.prototype.read;
        const firstRead = vi.spyOn(adapters.FileProjectIdentityStore.prototype, 'read').mockImplementationOnce(async function (this: adapters.FileProjectIdentityStore) {
          const project = await readProject.call(this);
          await configure(moved);
          return project;
        });
        try { expect.soft(await call({ ...hold, runId: 'drift', commandId: 'first-read-drift' })).toEqual(absent); }
        finally { firstRead.mockRestore(); await configure(data); }

        await setPolicy(runGrant('reserve'), inspectAbsent);
        lookup.mockImplementationOnce(() => configure(moved));
        try { expect.soft(await call()).toEqual(absent); }
        finally { await configure(data); }

        lookup.mockImplementationOnce(() => writeFile(policyPath, '{'));
        try { published(await call(), 'POLICY_UNAVAILABLE', locale); }
        finally { await setPolicy(runGrant('cancel')); }

        const afterDecision = (edit: () => Promise<void>) => vi.spyOn(RunDecisionApprovalBroker.prototype, 'authorize').mockImplementationOnce(async function (this: RunDecisionApprovalBroker, ...args) {
          const decision = await authorize.apply(this, args);
          await edit();
          return decision;
        });
        const layoutHold = { ...hold, runId: 'layout-edit', commandId: 'layout-edit' };
        const unrelated = afterDecision(() => configure(data, { scratch: 'other-scratch' }));
        let layoutReceipt;
        try {
          layoutReceipt = await call(layoutHold, false);
          expect.soft(layoutReceipt.structuredContent).toMatchObject({ lifecycle: { run: { revision: 1 } } });
        } finally { unrelated.mockRestore(); await configure(data); }
        const unrelatedReplay = vi.spyOn(RunDecisionApprovalBroker.prototype, 'authorize').mockImplementationOnce(async function (this: RunDecisionApprovalBroker, ...args) {
          await configure(data, { scratch: 'other-scratch' });
          return authorize.apply(this, args);
        });
        try {
          const replay = await call(layoutHold);
          expect.soft(replay.isError).not.toBe(true);
          expect.soft(replay).toEqual(layoutReceipt);
        } finally { unrelatedReplay.mockRestore(); await configure(data); }

        const policyEdit = afterDecision(() => withConfigWriteLock(policyPath, () => writePolicy(policyPath, 'still-allowed', runGrant('cancel'))));
        try {
          const committed = await call({ ...hold, runId: 'policy-edit', commandId: 'policy-edit' }, false);
          expect.soft(committed.structuredContent).toMatchObject({ lifecycle: { run: { revision: 1 } } });
          const [, receipts, , , , audit] = state();
          expect.soft(receipts!.filter(row => row['command_id'] === 'policy-edit').map(row => JSON.parse(String(row['command']))))
            .toEqual([expect.objectContaining({ decision: expect.objectContaining({ policyRevision: 'still-allowed' }) })]);
          expect.soft(audit!.map(row => JSON.parse(String(row['record'])).event).filter(event => event?.subject.commandId === 'policy-edit'))
            .toEqual([expect.objectContaining({ policyRevision: 'still-allowed' })]);
        } finally { policyEdit.mockRestore(); }

        await setPolicy(runGrant('reserve', 'inspect'), delegated);
        const revokeDelegate = afterDecision(() => withConfigWriteLock(policyPath, () => writePolicy(policyPath, 'delegation-withdrawn', runGrant('reserve', 'inspect'))));
        try { expect.soft(await call({ runId: 'race-visible', expectedRevision: 2, commandId: 'revoked-resume' })).toEqual(absent); }
        finally { revokeDelegate.mockRestore(); }
        await setPolicy(runGrant('cancel'));

        const withdraw = (timeoutMs?: number) => withConfigWriteLock(policyPath, () => writePolicy(policyPath, 'withdrawn'), timeoutMs);
        const revokeFirst = vi.spyOn(RunDecisionApprovalBroker.prototype, 'authorize').mockImplementationOnce(async function (this: RunDecisionApprovalBroker, ...args) {
          const decision = await authorize.apply(this, args);
          await withdraw();
          return decision;
        });
        try { expect.soft(await call({ ...hold, runId: 'policy-race', commandId: 'policy-race' })).toEqual(absent); }
        finally { revokeFirst.mockRestore(); }

        await setPolicy(runGrant('cancel'));
        let overtook = false;
        const writer = vi.spyOn(adapters, 'openSqliteAttemptStore').mockImplementationOnce(async (...args) => {
          try { await withdraw(0); overtook = true; }
          catch (error) { if (!isCodedError(error, 'CONFIG_WRITE_LOCKED')) throw error; }
          return openWriter(...args);
        });
        try {
          const raced = await call({ ...hold, runId: 'policy-race', commandId: 'policy-race' }, false);
          expect(writer).toHaveBeenCalledOnce();
          expect.soft(overtook).toBe(false);
          expect.soft(raced.structuredContent).toMatchObject({ lifecycle: { run: { revision: 1 } } });
        } finally { writer.mockRestore(); }
        await withdraw();
        expect.soft(await call({ ...hold, runId: 'policy-race', commandId: 'policy-race' })).toEqual(absent);

        await setPolicy(runGrant('cancel'));
        const identityStore = new adapters.FileInstallationIdentityStore(layout, undefined, undefined, installation);
        const { installationId } = await identityStore.loadOrCreate();
        const canonicalRoot = await realpath(layout.root), { dev, ino } = await stat(canonicalRoot, { bigint: true });
        await writeFile(join(productResourcePath(layout, 'installationIdentity'), 'identity.json'), JSON.stringify({ schemaVersion: 2, installationId,
          binding: { schemaVersion: 2, source: 'location', strength: 'weak', canonicalRoot, device: String(dev), inode: String(ino) }, lastResolution: null }));
        await expect(identityStore.read()).resolves.toMatchObject({ pendingWrite: true });
        const pending = await call({ ...hold, runId: 'drift', commandId: 'after-binding' }, false);
        expect.soft(pending.structuredContent).toMatchObject({ lifecycle: { run: { revision: 1 } } });
        expect.soft(await identityStore.read()).not.toHaveProperty('pendingWrite');
        expect.soft(await identityStore.read()).toMatchObject({ value: { installationId }, binding: { strength: 'machine' } });

        await configure(data, { installationIdentity: 'first-identity' }, { ...installation, requireMachineBinding: true });
        const firstIdentity = await call({ ...hold, runId: 'identity-first', commandId: 'identity-first' }, false);
        expect.soft(firstIdentity.structuredContent).toMatchObject({ lifecycle: { run: { revision: 1 } } });
        const firstBinding = readFile(join(data, 'first-identity', 'identity.json'), 'utf8').then(raw => JSON.parse(raw).binding);
        await expect.soft(firstBinding).resolves.toMatchObject({ strength: 'machine' });

        if (process.platform === 'linux') {
          const identityPath = join(productResourcePath(layout, 'installationIdentity'), 'identity.json');
          await writeFile(identityPath, JSON.stringify({ schemaVersion: 2, installationId,
            binding: { schemaVersion: 2, source: 'location', strength: 'weak', canonicalRoot, device: String(dev), inode: String(ino) }, lastResolution: null }));
          await configure(data, {}, { requireMachineBinding: true });
          machine.absent = true;
          try {
            const calls = installWrite.mock.calls.length, beforeWeak = state();
            const refused = await call({ ...hold, runId: 'identity-weak', commandId: 'identity-weak' }, false);
            published(refused, 'INSTALLATION_IDENTITY_MACHINE_BINDING_REQUIRED', locale);
            expect.soft(installWrite).toHaveBeenCalledTimes(calls + 1);
            expect.soft(state()).toEqual(beforeWeak);
          } finally { machine.absent = false; }
        }
      }
    } finally { await client.close(); await server.close(); }
  }
}, 45_000);
