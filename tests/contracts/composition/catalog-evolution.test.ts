import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineConfiguredAgent, defineConfiguredSkill, inspectConfiguredAgentStats, prepareConfiguredCatalogAggregation } from '#composition/core/agent-catalog/index.js';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { readLocalOsIdentity, withMcpPrincipal } from '#adapters/index.js';
import { aiAuthorityFloor, encodeDeckentJson, type DeckentMetrics, type JsonValue } from '#domain/index.js';
import { skillContentDigest } from '#engine/index.js';
import { clearConfigCache, prepareProductFile, resolveProductLayout } from '#platform/index.js';
import { createMcpServer } from '#surfaces/core/mcp/index.js';
import { agentsCommand } from '#surfaces/core/cli-agents/index.js';
import { metric, type MetricSpec } from '../support/catalog-metrics.js';

// S8-2 through the real composition (policy file, integrity key, SQLite ledger): `deckent agents stats` and MCP `inspect_agent_stats` are the
// catalog's `inspect` read over sealed metrics rows; the aggregator pass (mode off|shadow|on, protected) writes only its rebuildable position
// record — no standing, suggestion or card. Numbers carry "association, not causation" and "acceptance rate, not accuracy" on the view itself.
beforeEach(context => {
  if (process.platform === 'win32') context.skip('LOCAL_OS_PRINCIPAL_UNSUPPORTED: configured policy/integrity flows require a verified POSIX UID');
});
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const sqlite = { busyTimeoutMs: 1000, journalMode: 'delete' as const, durability: 'full' as const };
const person = { attest: async () => true };
async function fixture(options: { actions?: string[]; mcp?: string[]; catalogEvolution?: object } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-catalog-evolution-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await Promise.all([mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }), mkdir(data, { mode: 0o700 }), mkdir(home, { mode: 0o700 })]);
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, storage: { driver: 'sqlite', sqlite },
    ...options.catalogEvolution ? { catalogEvolution: options.catalogEvolution } : {} }), { mode: 0o600 });
  const ledger = await prepareProductFile(resolveProductLayout({ projectRoot: project, root: data }), 'ledger', ['-wal', '-shm', '-journal']);
  openSqliteLedger(ledger, sqlite).close();
  const id = readLocalOsIdentity(), principal = { issuer: id.issuer, subject: id.subject };
  const grants = [{ id: 'catalog', effect: 'allow', actions: options.actions ?? ['inspect', 'define'], scopes: ['scope'], principals: [principal], resource: { kind: 'agent-catalog', ids: 'all' } },
    ...options.mcp ? [{ id: 'catalog-mcp', effect: 'allow', actions: options.mcp, scopes: ['scope'], principals: [{ issuer: `${id.issuer}/mcp`, subject: id.subject }], resource: { kind: 'agent-catalog', ids: 'all' } }] : []];
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'catalog-policy', restrictions: [], grants }), { mode: 0o600 });
  return { project, ledger, options: { env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? '/usr/bin:/bin' } } };
}
const skill = { name: 'Fatura eşleştirme', text: 'Siparişi faturayla eşle; eşleşmeyeni onaya gönder.' }, pin = skillContentDigest(skill);
const agentCommand = (agentId: string, commandId: string, parentAgentId: string | null = null) => ({ schemaVersion: 1, commandId, scopeId: 'scope', agentId, expectedRevision: null,
  content: { name: agentId, persona: 'Faturaları siparişle eşleştirirsin.', workClasses: ['feature'], skills: [{ skillId: 'invoice-match', revision: 1, digest: pin }], parentAgentId } });
async function catalog(f: Awaited<ReturnType<typeof fixture>>) {
  await defineConfiguredSkill(f.project, { schemaVersion: 1, commandId: 'k1', scopeId: 'scope', skillId: 'invoice-match', expectedRevision: null, content: skill }, f.options, person);
  await defineConfiguredAgent(f.project, agentCommand('finance-lead', 'a1'), f.options, person);
  await defineConfiguredAgent(f.project, agentCommand('invoice-auditor', 'a2', 'finance-lead'), f.options, person);
}
let producer = 0;
/** Metric rows as the producers seal them (digest-sealed record + the producer's receipt carrying its sealed `now`). */
function seed(ledger: string, ...specs: MetricSpec[]) {
  const db = new DatabaseSync(ledger);
  try {
    for (const spec of specs) {
      const value: DeckentMetrics = metric(spec), id = `producer-${++producer}`, bytes = encodeDeckentJson(value as unknown as JsonValue);
      db.prepare("INSERT INTO run_receipts(scope_id,command_id,command,snapshot) VALUES(?,?,?,'{}')").run(value.identity.scopeId, id, JSON.stringify({ action: 'apply-task-evaluation', now: Date.now() - 3600000 }));
      db.prepare('INSERT INTO acceptance_metrics(scope_id,producer_command_id,run_id,task_id,attempt_id,outcome_kind,record) VALUES(?,?,?,?,?,?,?)').run(value.identity.scopeId, id, value.identity.runId,
        value.identity.taskId, value.identity.attemptId, value.outcome.kind, encodeDeckentJson({ schemaVersion: 1, metric: value as unknown as JsonValue, digest: createHash('sha256').update(bytes).digest('hex') }));
    }
  } finally { db.close(); }
}
const count = (ledger: string, table: string) => { const db = new DatabaseSync(ledger, { readOnly: true }); try { return Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.['n']); } finally { db.close(); } };
const auditor = (task: string, extra: Partial<MetricSpec> = {}): MetricSpec => ({ task, agent: ['invoice-auditor', 1], ...extra });
const work = [auditor('a1'), auditor('a2'), auditor('a3'), auditor('c1', { status: 'failed', cause: 'criteria-failed' }), auditor('i1', { status: 'failed', cause: 'infra' }),
  { task: 'l1', agent: ['finance-lead', 1] as const }, { task: 'l2', agent: ['finance-lead', 1] as const, status: 'failed' as const, cause: 'worker-report-failed' }, { task: 'n1', agent: null }];

describe('agents stats read', () => {
  it('a person reads one agent: only attributable failures count, the baseline excludes it, the labels travel on the view; the read writes nothing', async () => {
    const f = await fixture(); await catalog(f); seed(f.ledger, ...work);
    const before = await readFile(f.ledger);
    const view = await inspectConfiguredAgentStats(f.project, { schemaVersion: 1, scopeId: 'scope', agentId: 'invoice-auditor' }, f.options);
    expect(view).toMatchObject({ status: 'ok', mode: 'off', labels: { relation: 'association-not-causation', rate: 'acceptance-rate-not-accuracy' },
      registry: { status: 'provisional' }, rows: { read: 8, truncated: false }, lastPass: null });
    const key = view.agents[0]!.keys[0]!;
    expect(key).toMatchObject({ revision: 1, workClass: 'feature', standing: 'candidate', active: null,
      stats: { decided: 5, n: 4, successes: 3, wilson: { lowerMicro: 300636, upperMicro: 954414 }, unattributable: { infra: 1 }, perModel: [{ maker: 'unknown', tier: 'unknown', n: 4 }] },
      baseline: { n: 3, successes: 2 }, skills: [{ skillId: 'invoice-match', stats: { n: 6, successes: 4 } }] });
    expect(view.workClasses).toMatchObject([{ workClass: 'feature', stats: { n: 7, successes: 5 } }]);
    expect(await readFile(f.ledger)).toEqual(before);
  });
  it('a manager shows the team total of its reports (read-time sum, Wilson on the sum)', async () => {
    const f = await fixture(); await catalog(f); seed(f.ledger, ...work);
    const lead = await inspectConfiguredAgentStats(f.project, { schemaVersion: 1, scopeId: 'scope', agentId: 'finance-lead' }, f.options);
    expect(lead.agents[0]!.rollup).toMatchObject([{ workClass: 'feature', members: 2, n: 6, successes: 4 }]);
    const list = await inspectConfiguredAgentStats(f.project, { schemaVersion: 1, scopeId: 'scope', limit: 5 }, f.options);
    expect(list.agents.map(row => row.agentId).sort()).toEqual(['finance-lead', 'invoice-auditor']);
    expect(list.agents.every(row => row.keys.every(key => key.skills === null && key.stats.perModel === null))).toBe(true);
    expect(await inspectConfiguredAgentStats(f.project, { schemaVersion: 1, scopeId: 'scope', agentId: 'nobody' }, f.options)).toMatchObject({ status: 'not-found', agents: [] });
  });
  it('the MCP tool answers inside the granted scope only; without an inspect grant the read is refused', async () => {
    const f = await fixture({ mcp: ['inspect'] }); await catalog(f); seed(f.ledger, ...work);
    const mcp = createMcpServer({ inspectRun: async () => ({}), inspectInventory: async () => ({}),
      inspectAgentStats: query => withMcpPrincipal(() => inspectConfiguredAgentStats(f.project, query, f.options)) }, { maxConcurrentCalls: 2, responseMaxBytes: 262144 }, 'en');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); await mcp.connect(serverTransport);
    const client = new Client({ name: 'catalog-evolution-test', version: '1' }); await client.connect(clientTransport);
    try {
      const tool = (await client.listTools()).tools.find(row => row.name === 'inspect_agent_stats');
      expect(tool?.annotations?.readOnlyHint).toBe(true);
      const shown = await client.callTool({ name: 'inspect_agent_stats', arguments: { schemaVersion: 1, scopeId: 'scope', agentId: 'invoice-auditor' } });
      expect(shown.structuredContent).toMatchObject({ labels: { relation: 'association-not-causation' }, agents: [{ keys: [{ stats: { n: 4 } }] }] });
      expect((await client.callTool({ name: 'inspect_agent_stats', arguments: { schemaVersion: 1, scopeId: 'elsewhere' } })).isError).toBe(true);
    } finally { await client.close(); await mcp.close(); }
    const denied = await fixture({ actions: ['define'] });
    await expect(inspectConfiguredAgentStats(denied.project, { schemaVersion: 1, scopeId: 'scope' }, denied.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });
  it('the CLI says what the numbers are in the person\'s language (EN/TR), never raw codes', async () => {
    const f = await fixture(); await catalog(f); seed(f.ledger, ...work);
    for (const [lang, expected] of [['en', ['association, not causation', 'acceptance rate, not accuracy', '1/2 accepted, 2 decided', 'worker report 1', 'team total feature (2 agent(s)): 4/6 accepted, 7 decided']],
      ['tr', ['ilişki, nedensellik değil', 'kabul oranı, doğruluk değil', '3/4 kabul, 5 karara bağlandı', 'altyapı 1', 'güven aralığı %30,1–%95,4']]] as const) {
      let text = ''; const sink = { write: (chunk: string) => { text += chunk; return true; } };
      await agentsCommand(['agents', 'stats', lang === 'en' ? 'finance-lead' : 'invoice-auditor', '--scope', 'scope', '--lang', lang],
        { root: f.project, env: f.options.env, stdout: sink, stderr: sink, inspectAgentStats: (root, query, options) => inspectConfiguredAgentStats(root, query, options) });
      for (const phrase of expected) expect(text).toContain(phrase);
      expect(text).not.toMatch(/criteria-failed|association-not-causation|CATALOG_EVOLUTION/u);
    }
  });
});
describe('aggregator pass', () => {
  it('off loads nothing; shadow records one position with the touched keys, then nothing until a new row; no standing or catalog row changes', async () => {
    const f = await fixture({ catalogEvolution: { mode: 'shadow' } }); await catalog(f); seed(f.ledger, ...work);
    expect(prepareConfiguredCatalogAggregation(f.project, f.options, 'off')).toBeNull();
    const pass = prepareConfiguredCatalogAggregation(f.project, f.options, 'shadow')!, standings = count(f.ledger, 'agent_standing_revisions');
    const first = await pass.run('scope');
    expect(first).toMatchObject({ mode: 'shadow', previousPosition: 0, position: 8, rowsRead: 8, skippedKeys: 0 });
    expect(first!.keys).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'work-class', workClass: 'feature', n: 7, successes: 5 }),
      expect.objectContaining({ kind: 'agent', agentId: 'invoice-auditor', revision: 1, n: 4, successes: 3, wilson: { lowerMicro: 300636, upperMicro: 954414 } })]));
    expect(await pass.run('scope')).toBeNull();
    seed(f.ledger, auditor('a4'));
    expect(await pass.run('scope')).toMatchObject({ previousPosition: 8, position: 9, keys: [{ kind: 'work-class' }, { kind: 'agent', n: 5, successes: 4 }] });
    expect(count(f.ledger, 'catalog_evolution_positions')).toBe(1); expect(count(f.ledger, 'agent_standing_revisions')).toBe(standings);
    expect(await inspectConfiguredAgentStats(f.project, { schemaVersion: 1, scopeId: 'scope', agentId: 'invoice-auditor' }, f.options)).toMatchObject({ mode: 'shadow', lastPass: { position: 9 } });
  });
  it('a page bound stops the position before the row that would pass maxKeysPerPass; the next pass continues', async () => {
    const f = await fixture({ catalogEvolution: { mode: 'on', overlay: { revision: 'site', pass: { maxKeysPerPass: 2 } } } }); await catalog(f); seed(f.ledger, ...work);
    const pass = prepareConfiguredCatalogAggregation(f.project, f.options, 'on')!;
    expect(await pass.run('scope')).toMatchObject({ mode: 'on', position: 5, keys: [{ kind: 'work-class' }, { kind: 'agent', agentId: 'invoice-auditor' }] });
    expect(await pass.run('scope')).toMatchObject({ previousPosition: 5, position: 8 });
  });
  it('N34: an invalid registry overlay → typed refusal; the pass writes nothing and the read computes nothing', async () => {
    const f = await fixture({ catalogEvolution: { mode: 'shadow', overlay: { revision: 'site', stats: { readRowsMax: 999999 } } } }); await catalog(f); seed(f.ledger, ...work);
    await expect(prepareConfiguredCatalogAggregation(f.project, f.options, 'shadow')!.run('scope')).rejects.toMatchObject({ code: 'CATALOG_EVOLUTION_REGISTRY_UNAVAILABLE' });
    await expect(inspectConfiguredAgentStats(f.project, { schemaVersion: 1, scopeId: 'scope' }, f.options)).rejects.toMatchObject({ code: 'CATALOG_EVOLUTION_REGISTRY_UNAVAILABLE' });
    expect(count(f.ledger, 'catalog_evolution_positions')).toBe(0);
  });
  it('the switch and the registry overlay are protected configuration: no AI writes them', () => {
    const ai = { issuer: 'host/mcp', assurance: 'workload-verified' };
    for (const key of ['catalogEvolution', 'catalogEvolution.mode', 'catalogEvolution.overlay', 'catalogEvolution.overlay.rules'])
      for (const layer of ['project', 'global']) expect(aiAuthorityFloor(ai, { kind: 'config', id: `${layer}:${key}` }, 'write'), key).toBe(true);
  });
});
