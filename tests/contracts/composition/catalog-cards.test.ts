import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineConfiguredAgent, defineConfiguredFromSuggestion, draftConfiguredSuggestion, enrolConfiguredSigner, inspectConfiguredCatalogMonitor, listConfiguredSuggestions,
  prepareConfiguredCatalogAggregation, signedChangeConfiguredStanding, inspectConfiguredAgent } from '#composition/core/agent-catalog/index.js';
import { listConfiguredMemory, proposeConfiguredMemory, retireConfiguredMemory, verifyConfiguredMemory } from '#composition/core/memory/index.js';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { readLocalOsIdentity, withMcpPrincipal } from '#adapters/index.js';
import { encodeDeckentJson, type DeckentMetrics, type JsonValue } from '#domain/index.js';
import { clearConfigCache, prepareProductFile, resolveProductLayout } from '#platform/index.js';
import { createMcpServer } from '#surfaces/core/mcp/index.js';
import { metric, type MetricSpec } from '../support/catalog-metrics.js';

// S8-4 through the real composition (config, policy file, integrity key, SQLite ledger and memory journal): a lesson draft is rendered at card time from
// the person's own memory reads and never stored; defining from it is a person's terminal card that re-checks the draft; the MCP actor changes a standing
// only signed by its own enrolled key inside a WorkClass grant; the monitor names waiting suggestions and a running aggregator without its key.
beforeEach(context => {
  if (process.platform === 'win32') context.skip('LOCAL_OS_PRINCIPAL_UNSUPPORTED: configured policy/integrity flows require a verified POSIX UID');
});
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const sqlite = { busyTimeoutMs: 1000, journalMode: 'delete' as const, durability: 'full' as const };
const person = { attest: async () => true };
async function fixture(extraGrants: object[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-catalog-cards-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await Promise.all([mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }), mkdir(data, { mode: 0o700 }), mkdir(home, { mode: 0o700 })]);
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, storage: { driver: 'sqlite', sqlite }, catalogEvolution: { mode: 'on' } }), { mode: 0o600 });
  const ledger = await prepareProductFile(resolveProductLayout({ projectRoot: project, root: data }), 'ledger', ['-wal', '-shm', '-journal']);
  openSqliteLedger(ledger, sqlite).close();
  const id = readLocalOsIdentity(), me = { issuer: id.issuer, subject: id.subject }, aggregator = { issuer: `${id.issuer}/catalog-aggregator`, subject: id.subject };
  const rule = (ruleId: string, who: object, kind: string, actions: string[], ids: 'all' | string[] = 'all') => ({ id: ruleId, effect: 'allow', actions, scopes: ['scope'], principals: [who], resource: { kind, ids } });
  const grants = [rule('catalog', me, 'agent-catalog', ['inspect', 'define', 'promote', 'demote', 'restore', 'retire', 'dismiss']), rule('memory', me, 'memory', ['inspect', 'propose', 'verify', 'retire']),
    rule('signers', me, 'skill-signer', ['inspect', 'enrol']), rule('aggregator', aggregator, 'agent-catalog', ['inspect', 'suggest', 'narrow']), rule('aggregator-memory', aggregator, 'memory', ['inspect']),
    ...extraGrants.map(grant => ({ ...grant, principals: [{ issuer: `${id.issuer}/mcp`, subject: id.subject }] }))];
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'catalog-cards', restrictions: [], grants }), { mode: 0o600 });
  const options = { env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? '/usr/bin:/bin' } };
  const enrol = (principal: { issuer: string; subject: string }, commandId: string) => enrolConfiguredSigner(project, { schemaVersion: 1, scopeId: 'scope', commandId, principal, label: commandId }, options, person);
  return { project, ledger, options, id, aggregator, enrol, rule };
}
let producer = 0;
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
async function lessons(f: Awaited<ReturnType<typeof fixture>>, count = 3) {
  for (let i = 1; i <= count; i++) {
    await proposeConfiguredMemory(f.project, { schemaVersion: 1, commandId: `p-${i}`, scopeId: 'scope', content: { kind: 'lesson', title: `Ders ${i}`, body: 'Gövde', tags: [],
      lesson: { source: 'fatura işi', cause: `neden ${i}`, correction: `düzeltme ${i}`, evidence: 'kanıt' } }, origin: { kind: 'human', ref: null } }, f.options);
    const listed = await listConfiguredMemory(f.project, { schemaVersion: 1, scopeId: 'scope', limit: 50 }, f.options);
    const entry = listed.status === 'ok' ? listed.entries.find(row => row.content && 'title' in row.content && row.content.title === `Ders ${i}`)! : null;
    await verifyConfiguredMemory(f.project, { schemaVersion: 1, commandId: `v-${i}`, scopeId: 'scope', entryId: entry!.entryId, expectedRevision: 1, basis: { kind: 'human-review', note: 'checked' } }, f.options, person);
  }
}
const skillSuggestion = async (f: Awaited<ReturnType<typeof fixture>>) => (await listConfiguredSuggestions(f.project, { schemaVersion: 1, scopeId: 'scope', limit: 10 }, f.options)).items.find(row => row.kind === 'propose-skill')!;

describe('a lesson draft at card time (§6 fold A, N23, N36)', () => {
  it('rendered only on the person\'s terminal from what they may read; never on MCP; defining re-checks the digest and stores exactly that text as lessons-derived', async () => {
    const f = await fixture(); await f.enrol(f.aggregator, 'e-aggregator'); await lessons(f); seed(f.ledger, { task: 't1', scope: 'scope', agent: null });
    await prepareConfiguredCatalogAggregation(f.project, f.options, 'on')!.run('scope');
    const suggestion = await skillSuggestion(f);
    expect(suggestion.proposed).toMatchObject({ kind: 'skill-draft', withheld: 0 });
    const db = new DatabaseSync(f.ledger, { readOnly: true });
    try { expect(String(db.prepare('SELECT record FROM catalog_suggestions').all().map(r => r['record']).join())).not.toMatch(/Ders|düzeltme/); } finally { db.close(); }
    await expect(withMcpPrincipal(() => draftConfiguredSuggestion(f.project, { schemaVersion: 1, scopeId: 'scope', suggestionId: suggestion.suggestionId }, f.options)))
      .rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    const drafted = await draftConfiguredSuggestion(f.project, { schemaVersion: 1, scopeId: 'scope', suggestionId: suggestion.suggestionId }, f.options, person);
    expect(drafted).toMatchObject({ aiDerived: true, readable: 3, withheld: 0, draft: { kind: 'skill', lessons: 3, omitted: 0 } });
    expect(drafted.draft.kind === 'skill' && drafted.draft.content.text).toContain('- Ders 1: düzeltme 1 (cause: neden 1)');
    const input = { schemaVersion: 1, scopeId: 'scope', suggestionId: suggestion.suggestionId, id: 'lessons', expectedRevision: null };
    await expect(defineConfiguredFromSuggestion(f.project, { ...input, draftDigest: 'f'.repeat(64) }, f.options, person)).rejects.toMatchObject({ code: 'CATALOG_DRAFT_CHANGED' });
    const made = await defineConfiguredFromSuggestion(f.project, { ...input, draftDigest: drafted.digest }, f.options, person);
    expect(made.item).toMatchObject({ skillId: 'lessons', provenance: { origin: { kind: 'lessons-derived', suggestionId: suggestion.suggestionId } } });
    expect('content' in made.item && (made.item.content as { text: string }).text).toBe(drafted.draft.kind === 'skill' ? drafted.draft.content.text : null);
    await expect(defineConfiguredFromSuggestion(f.project, { ...input, id: 'again', draftDigest: drafted.digest }, f.options, person)).rejects.toMatchObject({ code: 'CATALOG_SUGGESTION_STALE' });
  });
  it('N23: with fewer readable lessons than the rule needs (one retired since), no draft is offered', async () => {
    const f = await fixture(); await f.enrol(f.aggregator, 'e-aggregator'); await lessons(f); seed(f.ledger, { task: 't1', scope: 'scope', agent: null });
    await prepareConfiguredCatalogAggregation(f.project, f.options, 'on')!.run('scope');
    const suggestion = await skillSuggestion(f), first = suggestion.proposed.kind === 'skill-draft' ? suggestion.proposed.lessons[0]! : null;
    await retireConfiguredMemory(f.project, { schemaVersion: 1, commandId: 'r1', scopeId: 'scope', entryId: first!.entryId, expectedRevision: 2, reason: 'eskidi', supersededBy: null }, f.options, person);
    await expect(draftConfiguredSuggestion(f.project, { schemaVersion: 1, scopeId: 'scope', suggestionId: suggestion.suggestionId }, f.options, person)).rejects.toMatchObject({ code: 'CATALOG_DRAFT_UNAVAILABLE' });
    expect((await skillSuggestion(f)).proposed).toMatchObject({ withheld: 1 });
  });
});

describe('the signed AI path on MCP and the monitor lines', () => {
  it('the MCP actor promotes only with a grant naming the WorkClass and its own enrolled key; a person may not use this path; the monitor names the open suggestion', async () => {
    const f = await fixture([{ id: 'mcp-feature', effect: 'allow', actions: ['promote', 'inspect'], scopes: ['scope'], resource: { kind: 'agent-catalog', ids: ['scope/feature', 'scope'] } }]);
    expect(await inspectConfiguredCatalogMonitor(f.project, 'scope', f.options)).toEqual(['catalog-aggregator-unsigned']);
    await defineConfiguredAgent(f.project, { schemaVersion: 1, commandId: 'a1', scopeId: 'scope', agentId: 'auditor', expectedRevision: null,
      content: { name: 'A', persona: 'Faturaları eşleştirirsin.', workClasses: ['feature'], skills: [], parentAgentId: null } }, f.options, person);
    await f.enrol(f.aggregator, 'e-aggregator');
    seed(f.ledger, ...Array.from({ length: 20 }, (_, i): MetricSpec => ({ task: `a${i}`, scope: 'scope', agent: ['auditor', 1], model: ['channel-a', i % 2 ? 'model-a' : 'model-b'] })),
      ...Array.from({ length: 10 }, (_, i): MetricSpec => ({ task: `b${i}`, scope: 'scope', agent: null, ...(i < 5 ? {} : { status: 'failed' as const, cause: 'criteria-failed' }) })));
    await prepareConfiguredCatalogAggregation(f.project, f.options, 'on')!.run('scope');
    expect(await inspectConfiguredCatalogMonitor(f.project, 'scope', f.options)).toEqual(['catalog-suggestions-open:1']);
    const command = { schemaVersion: 1, scopeId: 'scope', commandId: 'm1', action: 'promote', agentId: 'auditor', revision: 1, workClass: 'feature', expectedStandingRevision: 1, suggestionId: null };
    await expect(signedChangeConfiguredStanding(f.project, command, f.options)).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    const mcp = createMcpServer({ inspectRun: async () => ({}), inspectInventory: async () => ({}), listAgentSuggestions: query => withMcpPrincipal(() => listConfiguredSuggestions(f.project, query, f.options)),
      signedChangeStanding: input => withMcpPrincipal(() => signedChangeConfiguredStanding(f.project, input, f.options)) }, { maxConcurrentCalls: 2, responseMaxBytes: 262144 }, 'en');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); await mcp.connect(serverTransport);
    const client = new Client({ name: 'catalog-cards-test', version: '1' }); await client.connect(clientTransport);
    try {
      const tools = (await client.listTools()).tools;
      expect(tools.find(row => row.name === 'change_agent_standing')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
      expect(tools.find(row => row.name === 'list_agent_suggestions')?.annotations?.readOnlyHint).toBe(true);
      const unsigned = await client.callTool({ name: 'change_agent_standing', arguments: command });
      expect(unsigned.isError).toBe(true); expect(JSON.stringify(unsigned.content)).toContain('CATALOG_SIGNATURE_REQUIRED');
      await f.enrol({ issuer: `${f.id.issuer}/mcp`, subject: f.id.subject }, 'e-mcp');
      const signed = await client.callTool({ name: 'change_agent_standing', arguments: { ...command, commandId: 'm2' } });
      expect(signed.isError).toBeFalsy();
      const listed = await client.callTool({ name: 'list_agent_suggestions', arguments: { schemaVersion: 1, scopeId: 'scope', limit: 5 } });
      expect(listed.structuredContent).toMatchObject({ labels: { relation: 'association-not-causation' } });
    } finally { await client.close(); await mcp.close(); }
    const shown = await inspectConfiguredAgent(f.project, { schemaVersion: 1, scopeId: 'scope', agentId: 'auditor' }, f.options);
    expect(shown.status === 'ok' && shown.standings[0]).toMatchObject({ standing: 'active', basis: { kind: 'signed', decidedBy: { issuer: `${f.id.issuer}/mcp`, ai: true } } });
  });
});
