import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { inspectConfiguredMemory, listConfiguredMemory, prepareConfiguredMemoryExtraction, searchConfiguredMemory } from '#composition/core/memory/index.js';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { memoryKeyedDigest, openLocalIntegrityAuthority, openSqliteMemoryJournalStore, readLocalOsIdentity, withMcpPrincipal } from '#adapters/index.js';
import { encodeDeckentJson, memoryDistillerPrincipal, type JsonValue } from '#domain/index.js';
import { MemoryJournalApplication } from '#engine/index.js';
import { clearConfigCache, prepareProductFile, resolveProductLayout } from '#platform/index.js';
import { memoryCommand } from '#surfaces/core/cli-memory/index.js';
import { createMcpServer } from '#surfaces/core/mcp/index.js';

// S4B-1 through the real composition (policy file, integrity key, SQLite ledger v65): the distiller pass is wired off the hot path and does nothing
// when off; its page reader runs over the real schema; a system entry is withheld on the CLI and the MCP tools from a caller who may not read
// its source Attempt (§7.4, N25), and shown to one who may.
beforeEach(context => {
  if (process.platform === 'win32') context.skip('LOCAL_OS_PRINCIPAL_UNSUPPORTED: configured policy/integrity flows require a verified POSIX UID');
});
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const sqlite = { busyTimeoutMs: 1000, journalMode: 'delete' as const, durability: 'full' as const };
async function fixture(readOutput: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-memory-automation-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await Promise.all([mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }), mkdir(data, { mode: 0o700 }), mkdir(home, { mode: 0o700 })]);
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, storage: { driver: 'sqlite', sqlite } }), { mode: 0o600 });
  const layout = resolveProductLayout({ projectRoot: project, root: data }), ledger = await prepareProductFile(layout, 'ledger', ['-wal', '-shm', '-journal']);
  openSqliteLedger(ledger, sqlite).close();
  const person = readLocalOsIdentity(), me = { issuer: person.issuer, subject: person.subject }, mcp = { issuer: `${person.issuer}/mcp`, subject: person.subject };
  const distiller = { issuer: `${person.issuer}/memory-distiller`, subject: person.subject };
  const grant = (id: string, principals: object[], kind: string, actions: string[]) => ({ id, effect: 'allow', actions, scopes: ['scope'], principals, resource: { kind, ids: 'all' } });
  const grants = [grant('memory', [me, mcp], 'memory', ['inspect']), grant('distiller', [distiller], 'memory', ['inspect', 'propose']), grant('distiller-runs', [distiller], 'run', ['inspect']),
    ...(readOutput ? [grant('outputs', [me, mcp], 'attempt', ['read-output'])] : [])];
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'memory-automation', restrictions: [], grants }), { mode: 0o600 });
  const options = { env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? '/usr/bin:/bin' } };
  return { project, ledger, layout, person, options };
}
/** A system candidate written the way the distiller writes it (same integrity key, same store), with its source Attempt `a1`. */
async function systemEntry(f: Awaited<ReturnType<typeof fixture>>) {
  const integrity = await openLocalIntegrityAuthority(f.layout, 'authority.key', true);
  const app = new MemoryJournalApplication({ verifier: { verify: async () => memoryDistillerPrincipal(f.person, ['scope']) }, authorize: async () => ({ revision: 'p', ruleId: 'r' }),
    openStore: async access => openSqliteMemoryJournalStore(f.ledger, sqlite, integrity, access), keyedDigest: memoryKeyedDigest(integrity), now: () => 1_000, eventId: () => 'e1' });
  return (await app.proposeExtracted({ schemaVersion: 1, scopeId: 'scope', source: { runId: 'r1', taskId: 't1', attemptId: 'a1' }, ruleId: 'E1', ruleVersion: 1, claimIndex: 0,
    content: { kind: 'fact', title: 'Masraf merkezi zorunlu', body: 'Tedarikçi faturasında masraf merkezi alanı boş geçilemez.', tags: [], lesson: null },
    audience: { workClassFamily: 'small', workTargetId: null }, support: { producer: 'rule', evaluationId: 'ev1', evaluationDigest: 'e'.repeat(64), reportDigest: null } })).entry;
}
const out = () => { let text = ''; return { sink: { write(chunk: string) { text += chunk; } }, text: () => text }; };

it('N25: list, search and inspect withhold a system entry from a caller without read-output on its source (CLI and MCP), and show it with it', async () => {
  for (const readOutput of [false, true]) {
    const f = await fixture(readOutput), entry = await systemEntry(f);
    const listed = await listConfiguredMemory(f.project, { schemaVersion: 1, scopeId: 'scope', limit: 5 }, f.options);
    expect(listed).toMatchObject(readOutput ? { status: 'ok', withheld: 0, entries: [{ entryId: entry.entryId }] } : { status: 'ok', withheld: 1, entries: [] });
    const shown = out();
    await memoryCommand(['memory', '--scope', 'scope', '--lang', 'en'], { root: f.project, env: f.options.env, listMemory: listConfiguredMemory, stdout: shown.sink });
    expect(shown.text().includes('1 more entries are hidden')).toBe(!readOutput); expect(shown.text().includes('Masraf merkezi zorunlu')).toBe(readOutput);
    const inspected = inspectConfiguredMemory(f.project, { schemaVersion: 1, scopeId: 'scope', entryId: entry.entryId }, f.options);
    if (readOutput) await expect(inspected).resolves.toMatchObject({ status: 'ok' }); else await expect(inspected).rejects.toMatchObject({ code: 'MEMORY_ENTRY_WITHHELD' });
    const asMcp = <T>(work: () => Promise<T>) => withMcpPrincipal(work);
    const mcp = createMcpServer({ inspectRun: async () => ({}), inspectInventory: async () => ({}),
      listMemory: query => asMcp(() => listConfiguredMemory(f.project, query, f.options)), searchMemory: query => asMcp(() => searchConfiguredMemory(f.project, query, f.options)),
      inspectMemory: query => asMcp(() => inspectConfiguredMemory(f.project, query, f.options)) }, { maxConcurrentCalls: 2, responseMaxBytes: 65536 }, 'en');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); await mcp.connect(serverTransport);
    const client = new Client({ name: 'memory-automation-test', version: '1' }); await client.connect(clientTransport);
    try {
      const searched = await client.callTool({ name: 'search_memory', arguments: { schemaVersion: 1, scopeId: 'scope', query: 'masraf', limit: 5 } });
      expect(searched.structuredContent).toMatchObject({ status: 'ok', withheld: readOutput ? 0 : 1 });
      expect(JSON.stringify(searched.structuredContent).includes(entry.entryId)).toBe(readOutput);
      const inspectedMcp = await client.callTool({ name: 'inspect_memory', arguments: { schemaVersion: 1, scopeId: 'scope', entryId: entry.entryId } });
      expect(inspectedMcp.isError ?? false).toBe(!readOutput);
    } finally { await client.close(); await mcp.close(); }
  }
});

it('the distiller pass is off by default (nothing loads), and in shadow it pages the real ledger under its own identity, passing over a row without a Run', async () => {
  expect(prepareConfiguredMemoryExtraction('/nowhere', {}, 'off')).toBeNull();
  const f = await fixture(true), pass = prepareConfiguredMemoryExtraction(f.project, f.options, 'shadow')!;
  expect(await pass.run('scope')).toEqual({ processed: 0, outcomes: [] });
  // One accepted Task row whose Run is not in the ledger: the reader yields no source, the position still advances (never invented, never retried forever).
  const metric = { schemaVersion: 1, identity: { scopeId: 'scope', runId: 'gone', taskId: 't1', attemptId: 'a1' }, workClass: null, policyRevision: null, profileVersion: null,
    skillSetDigest: null, model: null, durationMs: null, cost: null, attemptSequence: 1, evidenceReferences: [], outcome: { kind: 'task', status: 'accepted' } };
  const record = encodeDeckentJson({ schemaVersion: 1, metric: metric as unknown as JsonValue, digest: createHash('sha256').update(encodeDeckentJson(metric as unknown as JsonValue), 'utf8').digest('hex') });
  const db = new DatabaseSync(f.ledger);
  try { db.prepare("INSERT INTO acceptance_metrics(scope_id,producer_command_id,run_id,task_id,attempt_id,outcome_kind,record) VALUES('scope','p1','gone','t1','a1','task',?)").run(record); }
  finally { db.close(); }
  expect(await pass.run('scope')).toEqual({ processed: 0, outcomes: [] });
  const check = new DatabaseSync(f.ledger, { readOnly: true });
  try { expect(check.prepare("SELECT count(*) AS n FROM memory_extraction_cursors WHERE scope_id='scope'").get()?.['n']).toBe(1); } finally { check.close(); }
  // A scope the distiller holds no grant in is refused, never silently empty.
  await expect(pass.run('elsewhere')).rejects.toBeTruthy();
});
