import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { releaseQuota, applyPoolHold, inspectPoolHold } from '../../../src/index.js';
import { withMcpPrincipal } from '#adapters/index.js';
import { createConfiguredRun, reserveConfiguredRunTasks, configuredLocalRunOffer } from '../../../src/composition/core/runs/index.js';
import { PermissionDefaultsRegistry, localRunFallbackClosed, localRunOffered } from '#engine/index.js';
import { advanceConfiguredRun } from '../../../src/composition/core/run-progression/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { main } from '../../../src/surfaces/index.js';
import { createMcpServer, type McpApplications } from '#surfaces/core/mcp/index.js';
import { clearConfigCache } from '#platform/index.js';
import { fixtureDockerRegistry } from '../support/execution-registry.js';

/** K5 typed pool hold through the real composition: SDK, CLI `pool` and MCP share one application; the progression the runtime service
 * runs turns a held pool into a quiet wait (no error, no reservation); refusals write no hold state. */
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const graph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 't', kind: 'selected', dependencies: [], acceptanceCriteria: ['exit'] }],
  criterionDefinitions: [{ id: 'exit', version: 1, description: 'zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };

async function fixture(controlScopes: 'all' | readonly string[] = 'all') {
  const root = await mkdtemp(join(tmpdir(), 'dn-pool-hold-surface-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'); await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, admission: { poolId: 'p',
    executionSlots: 2, inFlightSlots: 2, ordering: 'input-order', registry: fixtureDockerRegistry(['selected']) } }));
  const env = { HOME: join(root, 'home') }, options = { env };
  const opened = await openConfiguredAttemptStore(project, options);
  try { await opened.store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 2, inFlightSlots: 2 } }); } finally { opened.store.close(); }
  const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p1', restrictions: [], grants: [
    { id: 'run', effect: 'allow', actions: ['create', 'inspect', 'reserve'], scopes: ['s'], principals, resource: { kind: 'run', ids: 'all' } },
    { id: 'pool-use', effect: 'allow', actions: ['use', 'inspect'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
    { id: 'pool-control', effect: 'allow', actions: ['hold', 'resume', 'release-quota'], scopes: controlScopes, principals, resource: { kind: 'pool', ids: ['p'] } },
  ] }), { mode: 0o600 });
  const rows = (sql: string) => { const db = new DatabaseSync(opened.path, { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); } };
  const cli = async (...argv: string[]) => {
    const out: string[] = [], err: string[] = [];
    const code = await main(['pool', ...argv, ...(argv.includes('--no-scope') ? [] : ['--scope', 's'])].filter(arg => arg !== '--no-scope'), { root: project, env, initialize() {}, stdout: { write(value: string) { out.push(value); } },
      stderr: { write(value: string) { err.push(value); } }, releaseQuota: releaseQuota as never, applyPoolHold: applyPoolHold as never, inspectPoolHold: inspectPoolHold as never });
    return { code, stdout: out.join(''), stderr: err.join('') };
  };
  return { project, options, rows, cli };
}
async function mcp(applications: Partial<McpApplications>) {
  const server = createMcpServer({ async inspectRun() { return {}; }, async inspectInventory() { return {}; }, ...applications } as McpApplications,
    { maxConcurrentCalls: 1, responseMaxBytes: 1_000_000 }, 'en');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); await server.connect(serverTransport);
  const client = new Client({ name: 'pool-hold-surface-test', version: '1' }); await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

describe.skipIf(process.platform === 'win32')('K5 typed pool hold operator surface', () => {
  it('owner option A K2/K3 (Astra 2761 R1): a really held pool closes the run-here offer whatever the code; profile defaults close it; a scope with no pool is offered', async () => {
    const f = await fixture(), offer = (code?: string) => configuredLocalRunOffer(f.project, 's', f.options, code);
    expect(await offer()).toBe(true); expect(await offer('RUN_POOL_HELD')).toBe(false); expect(await offer('BRAIN_TIER_REFUSED')).toBe(false);
    expect((await f.cli('hold', '--command-id', 'k2-hold', '--reason', 'release', '--json')).code).toBe(0);
    expect(await offer('RUN_ADMISSION_NOT_CONFIGURED')).toBe(false); // the real hold row, not a mocked code, wins over "nothing set up"
    expect((await f.cli('resume', '--command-id', 'k2-resume', '--json')).code).toBe(0); expect(await offer()).toBe(true);
    const bare = await mkdtemp(join(tmpdir(), 'dn-local-run-')); roots.push(bare); await mkdir(join(bare, '.deckent'), { recursive: true, mode: 0o700 });
    await writeFile(join(bare, '.deckent/config.json'), JSON.stringify({ layout: { root: join(bare, 'data') } })); clearConfigCache();
    expect(await configuredLocalRunOffer(bare, 's', f.options)).toBe(false); // unreadable policy closes the alternate path
    const company = new PermissionDefaultsRegistry(), team = { id: 'acme:team', version: 1 };
    company.register([{ profile: team, openModes: [], startMode: 'standart', ownerBaseline: { families: [] }, localRunFallback: 'closed' }]);
    expect(localRunFallbackClosed(team, company)).toBe(true); expect(localRunFallbackClosed({ id: 'core:solo', version: 1 }, company)).toBe(false);
    expect(localRunOffered('RUN_ADMISSION_NOT_CONFIGURED', { closed: localRunFallbackClosed(team, company) })).toBe(false);
  });
  it('holds through the CLI; reservation and the runtime progression wait quietly with no write; status and the sealed audit show it; resume re-enables', async () => {
    const f = await fixture();
    await createConfiguredRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'create', graph }, f.options);
    const held = await f.cli('hold', '--command-id', 'cli-hold', '--reason', 'dev-release switch', '--json');
    expect(held.code).toBe(0);
    expect(JSON.parse(held.stdout)).toMatchObject({ changed: true, state: 'held', poolId: 'p', scopeId: 's', hold: { reason: 'dev-release switch', revision: 1 } });
    expect((await f.cli('hold', '--lang', 'en')).stdout).toContain('was already on hold'); // C-ADMIN human words
    // The composition reservation path (CLI `run reserve`, MCP `reserve_run_tasks`, runtime service) refuses with the typed code, writing nothing.
    await expect(reserveConfiguredRunTasks(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'reserve-1', expectedRevision: 0 }, f.options))
      .rejects.toMatchObject({ code: 'RUN_POOL_HELD' });
    // The runtime service's progression turn: a held pool is a quiet `waiting` (no thrown error, so no onError/back-off noise), nothing reserved.
    const turn = await advanceConfiguredRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r' }, new AbortController().signal, f.options);
    expect(turn).toMatchObject({ attempted: 0, stopped: false, run: { revision: 0, tasks: [{ phase: 'pending' }] } });
    expect(f.rows('SELECT count(*) AS n FROM attempts')[0]!.n).toBe(0);
    const status = JSON.parse((await f.cli('status', '--json')).stdout);
    expect(status).toMatchObject({ poolId: 'p', state: 'held', occupancy: { execution: 0, inFlight: 0 }, drained: true });
    expect(status).toEqual(await inspectPoolHold(f.project, { schemaVersion: 1, scopeId: 's' }, f.options));
    expect((await f.cli('status', '--lang', 'tr')).stdout).toContain('Boşaldı: bu havuzda çalışan iş kalmadı.');
    expect(f.rows("SELECT kind,scope_id FROM audit_events ORDER BY sequence")).toEqual([{ kind: 'authority-decision', scope_id: 's' }, { kind: 'pool-hold', scope_id: 's' }, { kind: 'pool-hold', scope_id: 's' }]);
    expect(JSON.parse((await f.cli('resume', '--command-id', 'cli-resume', '--json')).stdout)).toMatchObject({ changed: true, state: 'open' });
    const reserved = await reserveConfiguredRunTasks(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'reserve-2', expectedRevision: 0 }, f.options);
    expect(reserved.reservation.identities.map(identity => identity.taskId)).toEqual(['t']);
    // Usage errors never reach the application.
    for (const argv of [['pause'], ['status', '--reason', 'x'], ['hold', '--bogus', 'x'], ['hold', '--reason']]) expect((await f.cli(...argv)).code).toBe(2);
    // Without --scope the configured terminal scope is required (none here): a typed usage refusal, nothing applied.
    // C-ADMIN (owner CLI review 2026-10-19): a change off a terminal never takes a silent scope, configured or not.
  expect(await f.cli('hold', '--no-scope')).toMatchObject({ code: 2, stderr: expect.stringContaining('CLI_SCOPE_REQUIRED') });
  });

  it('refuses a hold held only in the caller scope (installation-level authority) with no hold state, over SDK, CLI and MCP alike', async () => {
    const f = await fixture(['s']);
    const command = { schemaVersion: 1, scopeId: 's', commandId: 'h', action: 'hold' as const };
    await expect(applyPoolHold(f.project, command, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    const cli = await f.cli('hold', '--command-id', 'h2');
    expect(cli.code).toBe(1); expect(cli.stderr).toContain('POLICY_DENIED');
    // BeUser D-04: the refusal names the cell and the founder card that grants the emergency hold.
    expect(cli.stderr).toContain('pool/hold'); expect(cli.stderr).toContain('deckent init policy --scope s --owner-baseline mcp-delegable --apply');
    const session = await mcp({ applyPoolHold: input => applyPoolHold(f.project, input, f.options), inspectPoolHold: input => inspectPoolHold(f.project, input, f.options) });
    try {
      expect(JSON.stringify(await session.client.callTool({ name: 'apply_pool_hold', arguments: { ...command, commandId: 'h3' } }))).toContain('POLICY_DENIED');
      const listed = await session.client.callTool({ name: 'inspect_pool_hold', arguments: { schemaVersion: 1, scopeId: 's' } });
      expect(listed.structuredContent).toEqual(await inspectPoolHold(f.project, { schemaVersion: 1, scopeId: 's' }, f.options));
      expect((await session.client.callTool({ name: 'apply_pool_hold', arguments: { ...command, action: 'pause' } })).isError).toBe(true);
    } finally { await session.close(); }
    expect(f.rows('SELECT count(*) AS n FROM execution_pool_holds')[0]!.n).toBe(0);
    expect(f.rows('SELECT count(*) AS n FROM execution_pool_hold_receipts')[0]!.n).toBe(0);
    // Each refusal is sealed (decision deny, no state).
    const events = f.rows('SELECT record FROM audit_events ORDER BY sequence').map(row => JSON.parse(String(row.record)).event.subject);
    expect(events).toHaveLength(3);
    for (const subject of events) expect(subject).toMatchObject({ kind: 'pool-hold', action: 'hold', decision: { effect: 'deny', ruleId: null }, state: null });
  });

  it('serves the same receipt over MCP as the SDK replay of that command', async () => {
    const f = await fixture();
    const session = await mcp({ applyPoolHold: input => applyPoolHold(f.project, input, f.options), inspectPoolHold: input => inspectPoolHold(f.project, input, f.options) });
    try {
      const command = { schemaVersion: 1, scopeId: 's', commandId: 'mcp-hold', action: 'hold' as const, reason: 'maintenance' };
      const applied = await session.client.callTool({ name: 'apply_pool_hold', arguments: command });
      expect(applied.isError).not.toBe(true);
      expect(applied.structuredContent).toEqual(await applyPoolHold(f.project, command, f.options));
      expect((await session.client.callTool({ name: 'inspect_pool_hold', arguments: { schemaVersion: 1, scopeId: 's' } })).structuredContent).toMatchObject({ state: 'held', drained: true });
    } finally { await session.close(); }
  });
});

it.skipIf(process.platform === 'win32')('quota-release CLI and SDK share audited receipts; MCP does not offer quota release until the delegation slice', async () => {
  const f = await fixture(), command = { schemaVersion: 1, scopeId: 's', commandId: 'cli-release', channelId: 'subscription-channel' };
  const result = await f.cli('quota-release', '--channel', command.channelId, '--command-id', command.commandId, '--json');
  expect(result.code).toBe(0); expect(JSON.parse(result.stdout)).toEqual(await releaseQuota(f.project, command, f.options));
  expect(JSON.parse(result.stdout)).toMatchObject({ released: 0, poolId: 'p', poolIds: [] });
  expect((await f.cli('quota-release', '--channel', command.channelId, '--lang', 'tr')).stdout).toContain('serbest bırakıldı');
  expect((await f.cli('quota-release')).code).toBe(2);
  const session = await mcp({ releaseQuota: input => withMcpPrincipal(() => releaseQuota(f.project, input, f.options)) });
  // hide_until_slice (owner 2026-10-18): the MCP actor is not offered quota release before the delegation slice; CLI/SDK keep it.
  try { expect((await session.client.listTools()).tools.map(tool => tool.name)).not.toContain('release_quota');
    expect(JSON.stringify(await session.client.callTool({ name: 'release_quota', arguments: { ...command, commandId: 'mcp-release' } }))).toContain('MCP_TOOL_UNKNOWN'); }
  finally { await session.close(); }
  expect(f.rows("SELECT count(*) n FROM quota_release_receipts")[0]!.n).toBe(2);
});

it.skipIf(process.platform === 'win32')('RC-C1: company run.create denial closes the shared offer before missing admission; inspect/tool grants do not bypass it', async () => {
  const f = await fixture(), configPath = join(f.project, '.deckent/config.json');
  await writeFile(configPath, JSON.stringify({ layout: { root: join(f.project, '../data') } })); clearConfigCache();
  const policyPath = join(f.project, '../data/policy.json'), document = JSON.parse(await (await import('node:fs/promises')).readFile(policyPath, 'utf8'));
  document.grants.push({ id: 'tools', effect: 'allow', actions: ['invoke'], scopes: ['s'], principals: 'all', resource: { kind: 'agent-tool', ids: 'all' } });
  document.restrictions = [{ id: 'company-stop', actions: ['create'], scopes: ['s'], principals: 'all', resource: { kind: 'run', ids: 'all' } }];
  await writeFile(policyPath, JSON.stringify(document), { mode: 0o600 });
  expect(await configuredLocalRunOffer(f.project, 's', f.options, 'RUN_ADMISSION_NOT_CONFIGURED')).toBe(false);
  document.restrictions = []; document.revision = 'open'; await writeFile(policyPath, JSON.stringify(document), { mode: 0o600 });
  expect(await configuredLocalRunOffer(f.project, 's', f.options, 'RUN_ADMISSION_NOT_CONFIGURED')).toBe(true);
  document.grants[0].actions = ['inspect']; document.revision = 'no-create-grant'; await writeFile(policyPath, JSON.stringify(document), { mode: 0o600 });
  expect(await configuredLocalRunOffer(f.project, 's', f.options)).toBe(false);
  await writeFile(policyPath, 'unreadable policy');
  expect(await configuredLocalRunOffer(f.project, 's', f.options)).toBe(false);
});
