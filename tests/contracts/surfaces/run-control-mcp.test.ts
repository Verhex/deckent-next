import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import { AttemptStoreError, AuthenticationError } from '#engine/index.js';
import { createMcpServer } from '#surfaces/core/mcp/index.js';
import { productResourcePath, t, type Locale } from '#platform/index.js';
import { openConfiguredAttemptStore } from '../support/configured-open.js';
import { fixtureExecution } from '../support/execution-registry.js';
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
  await mkdir(join(root, '.deckent'), { mode: 0o700 });
  await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ layout: { root: data } }), { mode: 0o600 });
  const { store, layout, path } = await openConfiguredAttemptStore(root, options);
  const owner = adapters.readLocalOsIdentity(), actor = mcpPrincipalRef(owner), scopeId = 's';
  const graph = { schemaVersion: 2, revision: 1, tasks: [{ id: 't', kind: 'fixture', dependencies: [], acceptanceCriteria: ['ok'] }],
    criterionDefinitions: [{ id: 'ok', version: 1, description: 'ok', evaluator: { id: 'test', version: 1 }, parameters: {} }] };
  const now = Date.now(), capacity = { executionSlots: 1, inFlightSlots: 1 };
  try {
    await store.createExecutionPool({ schemaVersion: 1, poolId: 'pool', capacity });
    for (const [runId, source] of [['operator', 'operator'], ['safety', 'nervous'], ['corrupt', 'operator'], ['fresh', null]] as const) {
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
  const setPolicy = (...grants: ReturnType<typeof grant>[]) => writeFile(policyPath, JSON.stringify({ schemaVersion: 1, revision: 'fixture',
    restrictions: [], grants: [grant('scope', 'scope', ['inspect'], [scopeId, 'foreign']), ...grants] }), { mode: 0o600 });
  const runGrant = (...actions: string[]) => grant('control', 'run', actions, [scopeId]);
  const delegated = grant('delegate-resume', 'run-decision', ['resume'], [scopeId]);
  const inspectAbsent = grant('inspect-absent', 'run', ['inspect'], [scopeId], ['absent']);
  const openReader = adapters.openSqliteInventoryReader;
  const lookup = vi.fn(), receiptRead = vi.fn();
  let readFailure = false;
  vi.spyOn(adapters, 'openSqliteInventoryReader').mockImplementation(async (...args) => {
    const reader = await openReader(...args), load = reader.loadRun.bind(reader), receipt = reader.loadRunReceipt.bind(reader);
    vi.spyOn(reader, 'loadRun').mockImplementation(async (...key) => {
      lookup(...key);
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
  const state = () => {
    const db = new DatabaseSync(path, { readOnly: true });
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
      }
    } finally { await client.close(); await server.close(); }
  }
});
