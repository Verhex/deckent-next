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
import { AttemptStoreError, AuthenticationError, ConfigApplication, RunDecisionApprovalBroker } from '#engine/index.js';
import { createMcpServer } from '#surfaces/core/mcp/index.js';
import { isCodedError, productResourcePath, t, withConfigWriteLock, writeConfig, type Locale } from '#platform/index.js';
import { openConfiguredAttemptStore } from '../support/configured-open.js';
import { fixtureExecution } from '../support/execution-registry.js';
const machine = vi.hoisted(() => ({ absent: false, contended: undefined as ((path: string) => void) | undefined, unlinkFault: undefined as string | undefined,
  watched: undefined as string | undefined, lockEvents: [] as string[] }));
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, readFile: (...args: Parameters<typeof original.readFile>) =>
    machine.absent && args[0] === '/etc/machine-id' ? Promise.reject(Object.assign(new Error('fixture machine id missing'), { code: 'ENOENT' })) : original.readFile(...args),
  // Lock observation and release faults at the filesystem boundary: the watched lock directory's creation and removal, an occupied lock
  // directory, a failing owner-record removal.
  mkdir: (...args: Parameters<typeof original.mkdir>) => original.mkdir(...args).then(made => {
    if (args[0] === machine.watched) machine.lockEvents.push('acquired');
    return made;
  }, (error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') machine.contended?.(String(args[0]));
    throw error;
  }),
  rmdir: (...args: Parameters<typeof original.rmdir>) => original.rmdir(...args).then(() => { if (args[0] === machine.watched) machine.lockEvents.push('released'); }),
  unlink: (...args: Parameters<typeof original.unlink>) => args[0] === machine.unlinkFault
    ? (machine.unlinkFault = undefined, Promise.reject(Object.assign(new Error('fixture release fault'), { code: 'EIO' }))) : original.unlink(...args) };
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
      ['layout-edit', null], ['policy-edit', null], ['busy-visible', null], ['busy-hidden', null], ['identity-first', null], ['identity-weak', null],
      ['run-first', null], ['release-fault', null]] as const) {
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

        // Owner 196, order (a): a real governed publication A -> B already holds the project settings lock when the Run reaches its final
        // write path. The Run waits for it, rereads B and is refused: neither ledger and neither key location changes.
        const configPath = join(root, '.deckent/config.json'), lockPath = `${configPath}.write-lock`;
        const keys = () => Promise.all([layout, other.layout].map(at => stat(join(productResourcePath(at, 'approvals'), 'authority.key')).then(() => true, () => false)));
        let inside!: () => void, publish!: () => void, waited!: () => void, authorizations = 0;
        const holding = new Promise<void>(done => { inside = done; }), publishing = new Promise<void>(done => { publish = done; });
        const contended = new Promise<void>(done => { waited = done; });
        const governed = new ConfigApplication(adapters.createConfigFileDocuments(root, options), { witness: async () => {}, audit: async () => {},
          async authorize() { if (++authorizations === 2) { inside(); await publishing; } return 'fixture'; } }); // the second call is under the lock
        // The caller may inspect the Run: a lock timeout would read M (CONFIG_WRITE_LOCKED); only a final read of B gives the general denial.
        await setPolicy(runGrant('cancel', 'inspect'));
        const publication = governed.set({ keyPath: 'layout.root', value: moved, principal: { ...owner, scopeIds: [scopeId] }, scopeId, commandId: 'publication-first' });
        await holding;
        const baseline = [effects(), state(other.path), await keys()];
        machine.contended = path => { if (path === lockPath) waited(); };
        machine.watched = lockPath; machine.lockEvents = [];
        try {
          const stale = call({ ...hold, runId: 'drift', commandId: 'publication-first' }, false);
          await Promise.race([contended, stale]);
          publish();
          await publication;
          expect.soft(JSON.parse(await readFile(configPath, 'utf8')).layout.root).toBe(moved);
          expect.soft(await stale).toEqual(absent);
          // The control took the lock only after the publication released it, then released it itself.
          expect.soft(machine.lockEvents).toEqual(['released', 'acquired', 'released']);
          expect.soft([effects(), state(other.path), await keys()]).toEqual(baseline);
        } finally { machine.contended = machine.watched = undefined; publish(); await publication.catch(() => undefined); await configure(data); await setPolicy(runGrant('cancel')); }

        // Order (b): the Run wins. Paused after its last bound read and before write admission (the MCP recheck of its decision), it holds the
        // project settings lock: a raw publication cannot take it, another project's control completes, the publication lands after the receipt.
        const elsewhere = await mkdtemp(join(tmpdir(), 'deckent-mcp-elsewhere-')); roots.push(elsewhere);
        await mkdir(join(elsewhere, '.deckent'), { mode: 0o700 });
        await writeFile(join(elsewhere, '.deckent/config.json'), JSON.stringify({ layout: { root: join(elsewhere, 'data') }, installation }), { mode: 0o600 });
        const second = await openConfiguredAttemptStore(elsewhere, options);
        try {
          await second.store.createExecutionPool({ schemaVersion: 1, poolId: 'pool', capacity });
          await second.store.createRun({ commandId: 'create-elsewhere', actor: { id: owner.id, issuer: owner.issuer, subject: owner.subject },
            identity: { scopeId, runId: 'elsewhere', layoutRevision: 'fixture' }, graph, execution: fixtureExecution(graph), now, policy: { schemaVersion: 2, poolId: 'pool', capacity, ordering: ['t'] } });
        } finally { second.store.close(); }
        await writeFile(productResourcePath(second.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'elsewhere', restrictions: [], grants: [{ id: 'run',
          effect: 'allow', principals: [{ issuer: owner.issuer, subject: owner.subject }], scopes: [scopeId], actions: ['inspect', 'cancel'], resource: { kind: 'run', ids: 'all' } }] }), { mode: 0o600 });
        let paused!: () => void, proceed!: () => void;
        const atBarrier = new Promise<void>(done => { paused = done; }), proceeding = new Promise<void>(done => { proceed = done; });
        const barrier = vi.spyOn(RunDecisionApprovalBroker.prototype, 'authorize').mockImplementation(async function (this: RunDecisionApprovalBroker, ...args) {
          if (args[4] !== undefined && args[0].commandId === 'run-first') { paused(); await proceeding; }
          return authorize.apply(this, args);
        });
        let ledger: { mockRestore(): void } | undefined;
        const moveRaw = (writeLockTimeoutMs?: number) => writeConfig(configPath, { layout: { root: moved, resources: {} }, installation, ...(writeLockTimeoutMs ? { configFile: { writeLockTimeoutMs } } : {}) });
        try {
          const first = call({ ...hold, runId: 'run-first', commandId: 'run-first' }, false);
          await atBarrier;
          const bytes = await readFile(configPath, 'utf8');
          await expect.soft(moveRaw(1)).rejects.toMatchObject({ code: 'CONFIG_WRITE_LOCKED' });
          expect.soft(await readFile(configPath, 'utf8')).toBe(bytes);
          await expect.soft(applyConfiguredRunLifecycle(elsewhere, { schemaVersion: 1, scopeId, runId: 'elsewhere', commandId: 'elsewhere', expectedRevision: 0,
            action: 'hold', holdReason: 'wait' }, options)).resolves.toMatchObject({ lifecycle: { run: { revision: 1 } } });
          // Still held inside the ledger commit itself: paused there, the one-try publication is refused again.
          let committing!: () => void, commit!: () => void;
          const atCommit = new Promise<void>(done => { committing = done; }), committed = new Promise<void>(done => { commit = done; });
          ledger = vi.spyOn(adapters, 'openSqliteAttemptStore').mockImplementation(async (...args) => {
            const store = await openWriter(...args), apply = store.commitRunLifecycle.bind(store);
            vi.spyOn(store, 'commitRunLifecycle').mockImplementation(async (write, ...rest) => {
              if (write.commandId === 'run-first') { committing(); await committed; }
              return apply(write, ...rest);
            });
            return store;
          });
          proceed();
          await atCommit;
          await expect.soft(moveRaw(1)).rejects.toMatchObject({ code: 'CONFIG_WRITE_LOCKED' });
          expect.soft(await readFile(configPath, 'utf8')).toBe(bytes);
          commit();
          expect.soft((await first).structuredContent).toMatchObject({ lifecycle: { commandId: 'run-first', run: { revision: 1 } } });
          await moveRaw();
          expect.soft(JSON.parse(await readFile(configPath, 'utf8')).layout.root).toBe(moved);
        } finally { proceed(); barrier.mockRestore(); ledger?.mockRestore(); await configure(data); }

        // Point 5(c): releasing the lock fails after the commit. The hold is recorded, so the caller receives the committed receipt; the owner
        // record of this live process stays (the existing stale-lock recovery reclaims it once the process has ended).
        const ownerRecord = join(lockPath, 'owner.json');
        machine.unlinkFault = ownerRecord;
        try {
          const faulted = await call({ ...hold, runId: 'release-fault', commandId: 'release-fault' }, false);
          expect.soft(faulted.structuredContent).toMatchObject({ lifecycle: { commandId: 'release-fault', run: { revision: 1 } } });
          expect.soft(machine.unlinkFault).toBeUndefined();
          await expect.soft(readFile(ownerRecord, 'utf8').then(JSON.parse)).resolves.toMatchObject({ pid: process.pid });
        } finally { machine.unlinkFault = undefined; await rm(lockPath, { recursive: true, force: true }); }

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
