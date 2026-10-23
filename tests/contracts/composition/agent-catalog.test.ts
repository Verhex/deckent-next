import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { generateKeyPairSync, sign } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { defineConfiguredAgent, defineConfiguredSkill, importConfiguredSkill, inspectConfiguredAgent, inspectConfiguredSkill, listConfiguredAgents, listConfiguredSkills } from '#composition/core/agent-catalog/index.js';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { readLocalOsIdentity, withMcpPrincipal } from '#adapters/index.js';
import { skillContentDigest, skillSignatureMessage } from '#engine/index.js';
import { clearConfigCache, prepareProductFile, resolveProductLayout } from '#platform/index.js';
import { createMcpServer } from '#surfaces/core/mcp/index.js';

// S7 agent/skill catalog through the real composition (policy file, integrity key, SQLite ledger): a person creates and revises on their own
// terminal card (the default card, AJAN-ORG S6); the AI (MCP actor) or a caller without the terminal witness is refused before anything is read,
// whatever policy grants; MCP has read tools only. An import verifies only against an `import` signer row a person registered (S8-5), so here it fails closed (floor d).
beforeEach(context => {
  if (process.platform === 'win32') context.skip('LOCAL_OS_PRINCIPAL_UNSUPPORTED: configured policy/integrity flows require a verified POSIX UID');
});
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const sqlite = { busyTimeoutMs: 1000, journalMode: 'delete' as const, durability: 'full' as const };
async function fixture(actions = ['inspect', 'define', 'import'], mcpActions: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-agent-catalog-composition-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await Promise.all([mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }), mkdir(data, { mode: 0o700 }), mkdir(home, { mode: 0o700 })]);
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, storage: { driver: 'sqlite', sqlite } }), { mode: 0o600 });
  const ledger = await prepareProductFile(resolveProductLayout({ projectRoot: project, root: data }), 'ledger', ['-wal', '-shm', '-journal']);
  openSqliteLedger(ledger, sqlite).close();
  const person = readLocalOsIdentity(), principal = { issuer: person.issuer, subject: person.subject };
  const grants = [{ id: 'catalog', effect: 'allow', actions, scopes: ['scope'], principals: [principal], resource: { kind: 'agent-catalog', ids: 'all' } },
    ...(mcpActions.length ? [{ id: 'catalog-mcp', effect: 'allow', actions: mcpActions, scopes: ['scope'], principals: [{ issuer: `${person.issuer}/mcp`, subject: person.subject }], resource: { kind: 'agent-catalog', ids: 'all' } }] : [])];
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'catalog-policy', restrictions: [], grants }), { mode: 0o600 });
  return { project, ledger, options: { env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? '/usr/bin:/bin' } } };
}
/** The person's terminal witness (Core composes the controlling terminal; the test process has none). */
const person = { attest: async () => true };
/** Rows in the catalog tables, read from the ledger file itself (a refused write may leave no integrity key, which a configured read requires). */
const rows = (ledger: string) => { const db = new DatabaseSync(ledger, { readOnly: true });
  try { return ['agent_definitions', 'skill_definitions', 'agent_catalog_receipts'].map(table => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.['n'])); } finally { db.close(); } };
const skill = { name: 'Fatura eşleştirme', text: 'Siparişi faturayla eşle; eşleşmeyeni onaya gönder.' };
const defineSkill = (commandId: string) => ({ schemaVersion: 1, commandId, scopeId: 'scope', skillId: 'invoice-match', expectedRevision: null, content: skill });
const agent = (commandId: string, digest: string, expectedRevision: number | null = null, workClasses = ['feature']) => ({ schemaVersion: 1, commandId, scopeId: 'scope', agentId: 'invoice-auditor',
  expectedRevision, content: { name: 'Fatura denetçisi', persona: 'Faturaları siparişle eşleştirirsin.', workClasses, skills: [{ skillId: 'invoice-match', revision: 1, digest }], parentAgentId: null } });
const vendor = generateKeyPairSync('ed25519'), pin = skillContentDigest(skill);
const signedImport = { schemaVersion: 1, commandId: 'i1', scopeId: 'scope', skillId: 'invoice-match', expectedRevision: null, content: skill, source: { ref: 'hub:verhex/invoice-match' }, pin,
  signature: { algorithm: 'ed25519', keyId: 'vendor-1', value: sign(null, Buffer.from(skillSignatureMessage({ skillId: 'invoice-match', contentDigest: pin })), vendor.privateKey).toString('base64') } };

it('a person defines a skill and an agent on their terminal; reads never write the ledger; WorkClass ids come from the registry', async () => {
  const f = await fixture();
  const made = await defineConfiguredSkill(f.project, defineSkill('k1'), f.options, person);
  expect(made.item).toMatchObject({ revision: 1, contentDigest: pin, provenance: { author: { ai: false } } });
  await expect(defineConfiguredAgent(f.project, agent('a0', pin, null, ['no-such-class']), f.options, person)).rejects.toMatchObject({ code: 'AGENT_WORK_CLASS_UNKNOWN' });
  expect((await defineConfiguredAgent(f.project, agent('a1', pin), f.options, person)).item).toMatchObject({ revision: 1, tier: null });
  expect((await defineConfiguredAgent(f.project, { ...agent('a2', pin, 1), content: { ...agent('a2', pin).content, name: 'Baş denetçi' } }, f.options, person)).item).toMatchObject({ revision: 2 });
  const before = await readFile(f.ledger);
  expect(await listConfiguredAgents(f.project, { schemaVersion: 1, scopeId: 'scope', limit: 5 }, f.options)).toMatchObject({ items: [{ agentId: 'invoice-auditor', revision: 2 }] });
  expect(await inspectConfiguredAgent(f.project, { schemaVersion: 1, scopeId: 'scope', agentId: 'invoice-auditor' }, f.options)).toMatchObject({ status: 'ok', history: [{ revision: 1 }, { revision: 2 }] });
  expect(await listConfiguredSkills(f.project, { schemaVersion: 1, scopeId: 'scope', limit: 5 }, f.options)).toMatchObject({ items: [{ skillId: 'invoice-match' }] });
  expect(await inspectConfiguredSkill(f.project, { schemaVersion: 1, scopeId: 'scope', skillId: 'invoice-match' }, f.options)).toMatchObject({ status: 'ok' });
  expect(await readFile(f.ledger)).toEqual(before);
});

it('negative: AI create without the card — the MCP actor and a caller without the terminal witness are refused even with a full policy grant', async () => {
  const f = await fixture(['inspect', 'define', 'import'], ['inspect', 'define', 'import']);
  const asMcp = <T>(work: () => Promise<T>) => withMcpPrincipal(work);
  for (const write of [() => defineConfiguredSkill(f.project, defineSkill('k1'), f.options, person), () => defineConfiguredAgent(f.project, agent('a1', pin), f.options, person),
    () => importConfiguredSkill(f.project, signedImport, f.options, person)])
    await expect(asMcp(write)).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
  await expect(defineConfiguredSkill(f.project, defineSkill('k2'), f.options)).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
  await expect(defineConfiguredAgent(f.project, agent('a2', pin), f.options, { attest: async () => false })).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
  expect(rows(f.ledger)).toEqual([0, 0, 0]);
});

it('negative: no import key is registered — a pinned, signed import fails closed for the person on their own terminal', async () => {
  const f = await fixture();
  await expect(importConfiguredSkill(f.project, signedImport, f.options, person)).rejects.toMatchObject({ code: 'SKILL_IMPORT_SIGNATURE_UNVERIFIED' });
  await expect(importConfiguredSkill(f.project, { ...signedImport, commandId: 'i2', signature: null }, f.options, person)).rejects.toMatchObject({ code: 'SKILL_IMPORT_UNSIGNED' });
  await expect(importConfiguredSkill(f.project, { ...signedImport, commandId: 'i3', pin: null }, f.options, person)).rejects.toMatchObject({ code: 'SKILL_IMPORT_UNPINNED' });
  expect(rows(f.ledger)).toEqual([0, 0, 0]);
});

it('the MCP read tools answer inside the granted scope only; a scope without a grant is refused', async () => {
  const f = await fixture(['inspect', 'define'], ['inspect']);
  await defineConfiguredSkill(f.project, defineSkill('k1'), f.options, person); await defineConfiguredAgent(f.project, agent('a1', pin), f.options, person);
  const asMcp = <T>(work: () => Promise<T>) => withMcpPrincipal(work);
  const mcp = createMcpServer({ inspectRun: async () => ({}), inspectInventory: async () => ({}),
    listAgents: query => asMcp(() => listConfiguredAgents(f.project, query, f.options)), inspectAgent: query => asMcp(() => inspectConfiguredAgent(f.project, query, f.options)),
    listSkills: query => asMcp(() => listConfiguredSkills(f.project, query, f.options)), inspectSkill: query => asMcp(() => inspectConfiguredSkill(f.project, query, f.options)) },
  { maxConcurrentCalls: 2, responseMaxBytes: 65536 }, 'en');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); await mcp.connect(serverTransport);
  const client = new Client({ name: 'agent-catalog-composition-test', version: '1' }); await client.connect(clientTransport);
  try {
    const tools = (await client.listTools()).tools.filter(tool => /_(agents?|skills?)$/.test(tool.name));
    expect(tools.map(tool => [tool.name, tool.annotations?.readOnlyHint])).toEqual([['list_agents', true], ['inspect_agent', true], ['list_skills', true], ['inspect_skill', true]]);
    const shown = await client.callTool({ name: 'inspect_agent', arguments: { schemaVersion: 1, scopeId: 'scope', agentId: 'invoice-auditor' } });
    expect(shown.structuredContent).toMatchObject({ status: 'ok', item: { agentId: 'invoice-auditor', skillSetDigest: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect((await client.callTool({ name: 'list_skills', arguments: { schemaVersion: 1, scopeId: 'elsewhere', limit: 5 } })).isError).toBe(true);
  } finally { await client.close(); await mcp.close(); }
  const denied = await fixture(['define']);
  await expect(listConfiguredAgents(denied.project, { schemaVersion: 1, scopeId: 'scope', limit: 5 }, denied.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
});
