import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { countConfiguredMemoryPurgesPending, listConfiguredMemory, proposeConfiguredMemory, purgeConfiguredMemory, replayConfiguredMemoryPurges, reviewConfiguredMemory } from '#composition/core/memory/index.js';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { readLocalOsIdentity, withMcpPrincipal } from '#adapters/index.js';
import { clearConfigCache, prepareProductFile, resolveProductLayout } from '#platform/index.js';

// S4B-4 through the real composition (policy file, integrity key, SQLite ledger, purge journal under state/memory-purges): the purge is a person's
// terminal act (witness; the MCP actor is refused even with a grant), and a ledger restored from before the purge holds reads until the journal is
// re-applied — by the service start replay or by the person's next write.
beforeEach(context => {
  if (process.platform === 'win32') context.skip('LOCAL_OS_PRINCIPAL_UNSUPPORTED: configured policy/integrity flows require a verified POSIX UID');
});
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const sqlite = { busyTimeoutMs: 1000, journalMode: 'delete' as const, durability: 'full' as const };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-memory-purge-composition-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await Promise.all([mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }), mkdir(data, { mode: 0o700 }), mkdir(home, { mode: 0o700 })]);
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, storage: { driver: 'sqlite', sqlite } }), { mode: 0o600 });
  const ledger = await prepareProductFile(resolveProductLayout({ projectRoot: project, root: data }), 'ledger', ['-wal', '-shm', '-journal']);
  openSqliteLedger(ledger, sqlite).close();
  const person = readLocalOsIdentity(), principal = { issuer: person.issuer, subject: person.subject };
  const grants = [{ id: 'memory', effect: 'allow', actions: ['inspect', 'propose', 'retire', 'purge'], scopes: ['scope'], principals: [principal], resource: { kind: 'memory', ids: 'all' } },
    { id: 'memory-mcp', effect: 'allow', actions: ['inspect', 'purge'], scopes: ['scope'], principals: [{ issuer: `${person.issuer}/mcp`, subject: person.subject }], resource: { kind: 'memory', ids: 'all' } }];
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'memory-policy', restrictions: [], grants }), { mode: 0o600 });
  return { project, data, ledger, options: { env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? '/usr/bin:/bin' } } };
}
const content = { kind: 'fact', title: 'Müşteri Ayşe Yılmaz', body: 'Ayşe Yılmaz faturaları e-posta ile ister.', tags: [], lesson: null };
const propose = (commandId: string, body = content) => ({ schemaVersion: 1, commandId, scopeId: 'scope', content: body, origin: { kind: 'human', ref: null } });
const purge = (commandId: string) => ({ schemaVersion: 1, commandId, scopeId: 'scope', entryId: 'm1', expectedRevision: 1, reasonCode: 'personal-data' as const });
const person = { attest: async () => true }, noTerminal = { attest: async () => false };

it('only the person on their terminal purges; the journal survives a ledger restore and the service start replay re-applies it before any read', async () => {
  const f = await fixture();
  await proposeConfiguredMemory(f.project, propose('m1'), f.options);
  await copyFile(f.ledger, `${f.ledger}.before-purge`);
  await expect(purgeConfiguredMemory(f.project, purge('x0'), f.options, noTerminal)).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
  await expect(withMcpPrincipal(() => purgeConfiguredMemory(f.project, purge('x0'), f.options, person))).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
  const result = await purgeConfiguredMemory(f.project, purge('x1'), f.options, person);
  expect(result).toMatchObject({ replayed: false, entry: { content: { purged: true, reasonCode: 'personal-data' } } });
  const journal = await readFile(join(f.data, 'state', 'memory-purges', 'purges.jsonl'), 'utf8');
  expect(journal).toContain('"purgeId":"x1"'); expect(journal).not.toContain('Ayşe');
  // Not even freed pages or search-index segments keep the text (secure delete + index merge), folded tokens included.
  { const raw = await readFile(f.ledger); for (const word of ['Yılmaz', 'yilmaz', 'ayse', 'Ayşe', 'faturalari']) expect(raw.includes(Buffer.from(word)), word).toBe(false); }
  expect(await countConfiguredMemoryPurgesPending(f.project, f.options)).toBe(0);
  // A backup from before the purge comes back: the journal stays, the ledger has the text again, and every read holds.
  await copyFile(`${f.ledger}.before-purge`, f.ledger);
  expect(await countConfiguredMemoryPurgesPending(f.project, f.options)).toBe(1);
  expect(await listConfiguredMemory(f.project, { schemaVersion: 1, scopeId: 'scope', limit: 10 }, f.options)).toMatchObject({ status: 'held', code: 'MEMORY_PURGE_REPLAY_HELD' });
  expect(await reviewConfiguredMemory(f.project, { schemaVersion: 1, scopeId: 'scope', limit: 10 }, f.options)).toMatchObject({ status: 'held', code: 'MEMORY_PURGE_REPLAY_HELD' });
  expect(await replayConfiguredMemoryPurges(f.project, f.options)).toEqual({ scopes: 1, records: 1, applied: 1, invocationsPurged: 0 });
  expect(await listConfiguredMemory(f.project, { schemaVersion: 1, scopeId: 'scope', limit: 10 }, f.options)).toMatchObject({ status: 'ok', entries: [{ entryId: 'm1', content: { purged: true } }] });
  expect(await countConfiguredMemoryPurgesPending(f.project, f.options)).toBe(0);
  await expect(proposeConfiguredMemory(f.project, propose('m2'), f.options)).rejects.toMatchObject({ code: 'MEMORY_PURGED_CONTENT' });
});

it('after a restore the person\'s next write re-applies the pending purge first; an altered journal holds the service start', async () => {
  const f = await fixture();
  await proposeConfiguredMemory(f.project, propose('m1'), f.options);
  await copyFile(f.ledger, `${f.ledger}.before-purge`);
  await purgeConfiguredMemory(f.project, purge('x1'), f.options, person);
  await copyFile(`${f.ledger}.before-purge`, f.ledger);
  await proposeConfiguredMemory(f.project, propose('m3', { ...content, title: 'Başka', body: 'Başka bir kural.' }), f.options);
  expect(await countConfiguredMemoryPurgesPending(f.project, f.options)).toBe(0);
  const path = join(f.data, 'state', 'memory-purges', 'purges.jsonl');
  await writeFile(path, (await readFile(path, 'utf8')).replace('personal-data', 'other'));
  await expect(replayConfiguredMemoryPurges(f.project, f.options)).rejects.toMatchObject({ code: 'MEMORY_PURGE_REPLAY_HELD' });
  expect(await listConfiguredMemory(f.project, { schemaVersion: 1, scopeId: 'scope', limit: 10 }, f.options)).toMatchObject({ status: 'held', code: 'MEMORY_PURGE_REPLAY_HELD' });
});
