import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inspectMonitor } from '#composition/index.js';
import { mcpApplications } from '#composition/core/mcp/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { openSqliteAttemptStore } from '#adapters/index.js';
import { mcpPrincipalRef } from '#domain/index.js';
import { MonitorSourceMemo } from '#engine/index.js';
import { clearConfigCache, productResourcePath } from '#platform/index.js';
import { loadMonitorSurface } from '#surfaces/core/monitor/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
import { custodyProfiles } from '../support/custody.js';

// MON-NAMES (owner 2026-10-19, PLAN §16): the real policy decision (`monitor inspect-scope-diagnostics`, installation-wide) decides whether
// the one snapshot producer names refused scopes; text, `--json`, MCP and the live view all read that snapshot. Revoking the grant takes
// effect on the next live read, the MCP actor never inherits the person's grant, and a failed decision is counts plus one nameless reason.
beforeEach(context => {
  if (process.platform === 'win32') context.skip('LOCAL_OS_PRINCIPAL_UNSUPPORTED: monitor policy fixture requires verified POSIX UID');
});
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const HEARTBEAT_MS = 100;
const settle = () => new Promise(resolve => setTimeout(resolve, HEARTBEAT_MS + 60));
const actor = { id: 'fixture', issuer: 'test', subject: 'service' };
const me = { issuer: hostname(), subject: String(userInfo().uid) }, myMcp = mcpPrincipalRef(me);
// Distinctive id so a leak is found by text search in the whole snapshot.
const HIDDEN = 'scope-hidden-kappa';
const graph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 't', kind: 'fixture', dependencies: [], acceptanceCriteria: ['verified'] }],
  criterionDefinitions: [{ id: 'verified', version: 1, description: 'fixture', evaluator: { id: 'test', version: 1 }, parameters: {} }] };
const capacity = { executionSlots: 4, inFlightSlots: 4 };
const NAMES_RULE = { id: 'first-run-monitor-scope-diagnostics', effect: 'allow', actions: ['inspect-scope-diagnostics'], scopes: 'all', principals: [me], resource: { kind: 'monitor', ids: 'all' } };

/** Scope `s` is the viewer's; scope HIDDEN has a Run the viewer may not inspect (refused). */
async function install() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-monitor-names-')); roots.push(root);
  const dir = join(root, 'current'); await mkdir(join(dir, '.deckent'), { recursive: true, mode: 0o700 });
  await writeFile(join(dir, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'data') }, inspection: { workers: { sources: [], heartbeatMs: HEARTBEAT_MS } } }));
  const options = { env: { HOME: join(root, 'home') } };
  const opened = await openConfiguredAttemptStore(dir, options); opened.store.close();
  const store = await openSqliteAttemptStore(opened.path, { busyTimeoutMs: 100, journalMode: 'wal', durability: 'full' }, { now: Date.now, timeoutMs: 86400000 }, 'allow', custodyProfiles);
  try {
    await store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity });
    for (const [index, scopeId] of ['s', HIDDEN].entries()) await store.createRun({ commandId: 'create-' + scopeId, actor, identity: { scopeId, runId: 'r-' + index, layoutRevision: 'layout' },
      graph, execution: fixtureExecution(graph), now: 10_000 + index, policy: { schemaVersion: 2, poolId: 'p', capacity, ordering: ['t'] } });
  } finally { store.close(); }
  /** The viewer reads scope `s`; `names` adds the monitor grant (true = the v13 rule, or a rule override); `mcp` lets the MCP actor read `s` too. */
  const policy = (names: boolean | Record<string, unknown>, mcp = false, raw?: string) => {
    const principals = mcp ? [me, myMcp] : [me];
    return writeFile(productResourcePath(opened.layout, 'policy'), raw ?? JSON.stringify({ schemaVersion: 1, revision: 'names', restrictions: [], grants: [
      { id: 'scope', effect: 'allow', scopes: ['s'], principals, actions: ['inspect'], resource: { kind: 'scope', ids: ['s'] } },
      { id: 'runs', effect: 'allow', scopes: ['s'], principals, actions: ['inspect'], resource: { kind: 'run', ids: 'all' } },
      ...(names ? [{ ...NAMES_RULE, ...(names === true ? {} : names) }] : []),
    ] }), { mode: 0o600 });
  };
  const inspect = async (memo?: MonitorSourceMemo) => { clearConfigCache(); return (await inspectMonitor(dir, options, { schemaVersion: 1 }, memo)).installs[0]!; };
  return { dir, options, policy, inspect };
}
const refusedNamed = (codes: readonly string[]) => codes.filter(code => code.startsWith('scope-refused:'));

describe('monitor scope names through the real policy decision (MON-NAMES)', () => {
  it('admin (holds `monitor inspect-scope-diagnostics`): the refused scope is named with its reason, in text EN/TR and JSON alike', async () => {
    const f = await install(); await f.policy(true);
    const admin = await f.inspect();
    expect(admin).toMatchObject({ status: 'available', scopeIds: ['s'] });
    expect(refusedNamed(admin.diagnostics)).toEqual([expect.stringMatching(new RegExp(`^scope-refused:[A-Z_]+:${HIDDEN}$`))]);
    expect(admin.diagnostics.some(code => code.startsWith('scopes-denied'))).toBe(false);
    // Still a refusal: no Run of the named scope is read.
    expect(admin.runs.map(run => run.scopeId)).toEqual(['s']);
    const surface = await loadMonitorSurface(), snapshot = { schemaVersion: 1 as const, observedAt: 40_000, control: 'observe-only' as const, sourcesRead: ['current'], installs: [admin] };
    expect(surface.renderMonitorText(snapshot, { locale: 'en', width: 400, ascii: true })).toMatch(new RegExp(`access to scope ${HIDDEN} was refused \\([A-Z_]+\\)`));
    expect(surface.renderMonitorText(snapshot, { locale: 'tr', width: 400, ascii: true })).toMatch(new RegExp(`${HIDDEN} kapsamına erişim reddedildi \\([A-Z_]+\\)`));
  });

  it('negative: a user without the grant sees a count; the snapshot (`--json`, MCP) and its text carry no id', async () => {
    const f = await install(); await f.policy(false);
    const user = await f.inspect();
    expect(user.diagnostics).toContain('scopes-denied:1');
    expect(refusedNamed(user.diagnostics)).toEqual([]);
    expect(JSON.stringify(user)).not.toContain(HIDDEN);
    const surface = await loadMonitorSurface(), snapshot = { schemaVersion: 1 as const, observedAt: 40_000, control: 'observe-only' as const, sourcesRead: ['current'], installs: [user] };
    for (const locale of ['en', 'tr'] as const) expect(surface.renderMonitorText(snapshot, { locale, width: 400, ascii: true })).not.toContain(HIDDEN);
  });

  it('negative: a grant narrower than the installation (one scope, or named ids) keeps the counts', async () => {
    const f = await install();
    for (const narrow of [{ scopes: ['s'] }, { resource: { kind: 'monitor', ids: ['current'] } }]) {
      await f.policy(narrow); const viewer = await f.inspect();
      expect(viewer.diagnostics).toContain('scopes-denied:1'); expect(JSON.stringify(viewer)).not.toContain(HIDDEN);
    }
  });

  it('negative: a revoked grant gives counts on the next live read (the policy stamp is part of the memo generation)', async () => {
    const f = await install(); await f.policy(true); await f.inspect(); await settle();
    const memo = new MonitorSourceMemo();
    expect(refusedNamed((await f.inspect(memo)).diagnostics)).toHaveLength(1);
    expect(refusedNamed((await f.inspect(memo)).diagnostics)).toHaveLength(1); // recalled within the generation
    await f.policy(false);
    const within = await f.inspect(memo); // within one heartbeat of the write: read through
    expect(within.diagnostics).toContain('scopes-denied:1'); expect(JSON.stringify(within)).not.toContain(HIDDEN);
    await settle();
    const settled = await f.inspect(memo); // settled: a new generation, the decision is asked again
    expect(settled.diagnostics).toContain('scopes-denied:1'); expect(JSON.stringify(settled)).not.toContain(HIDDEN);
    await f.policy(true); await settle();
    expect(refusedNamed((await f.inspect(memo)).diagnostics)).toHaveLength(1);
  });

  it('negative: the MCP viewer never inherits the person\'s grant — counts, no id', async () => {
    const f = await install(); await f.policy(true, true);
    expect(refusedNamed((await f.inspect()).diagnostics)).toHaveLength(1);
    const mcp = (await mcpApplications({ inspectMonitor: () => inspectMonitor(f.dir, f.options) }).inspectMonitor()).installs[0]!;
    expect(mcp).toMatchObject({ status: 'available', scopeIds: ['s'] });
    expect(mcp.diagnostics).toContain('scopes-denied:1');
    expect(JSON.stringify(mcp)).not.toContain(HIDDEN);
  });

  it('negative: a decision that cannot be made is fail-closed — counts and one reason without any scope id', async () => {
    const f = await install(); await f.policy(false, false, '{ not json');
    const broken = await f.inspect();
    expect(broken.diagnostics.filter(code => code.startsWith('scope-diagnostics-unavailable:'))).toHaveLength(1);
    expect(broken.diagnostics.some(code => code.startsWith('scopes-unavailable:2'))).toBe(true);
    expect(JSON.stringify(broken)).not.toContain(HIDDEN);
    expect(JSON.stringify(broken)).not.toMatch(/"s"|scope-refused|scope-failed/);
  });
});
