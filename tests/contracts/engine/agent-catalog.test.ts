import { generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { openSqliteAgentCatalogStore } from '#adapters/index.js';
import { AgentCatalogApplication, skillContentDigest, skillSetDigest, skillSignatureMessage, type AgentCatalogDependencies } from '#engine/index.js';
import { AGENT_CATALOG_LIMITS } from '#domain/index.js';
import { createHmacIntegrity } from '#platform/index.js';

// S7 agent/skill catalog core, engine contract over the Core SQLite store. The application is the single transition owner (create/revise by
// expected-revision compare-and-set, command receipts, one audit event each); the store re-checks the org tree inside its write transaction.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const };
const integrity = createHmacIntegrity('catalog-key', randomBytes(32));
const human = { id: 'h', issuer: 'local-os', subject: 'uid:1000', assurance: 'os-user' as const, scopeIds: ['s', 'other'] };
const mcp = { id: 'm', issuer: 'local-os/mcp', subject: 'uid:1000', assurance: 'os-user' as const, scopeIds: ['s', 'other'] };
const vendor = generateKeyPairSync('ed25519'), stranger = generateKeyPairSync('ed25519');
/** A test verifier with one trusted key: Core composes none (fail closed); a hub/Enterprise adapter supplies its own trust anchors. */
const trusted: AgentCatalogDependencies['verifySkillSignature'] = async (signature, message) => {
  const key = ({ 'vendor-1': vendor.publicKey } as Record<string, KeyObject>)[signature.keyId];
  return !key ? 'unknown-key' : verify(null, Buffer.from(message), key, Buffer.from(signature.value, 'base64')) ? 'valid' : 'invalid';
};
async function fixture(principal: typeof human = human, extra: Partial<AgentCatalogDependencies> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dn-agent-catalog-')); roots.push(root);
  const path = join(root, 'ledger.db'); openSqliteLedger(path, options).close();
  let ids = 0;
  const deps: AgentCatalogDependencies = { verifier: { verify: async () => principal }, authorize: async () => ({ revision: 'p', ruleId: 'r' }),
    openStore: async access => openSqliteAgentCatalogStore(path, options, integrity, access), now: () => 1_000, eventId: () => `e${++ids}`, ...extra };
  return { path, app: new AgentCatalogApplication(deps) };
}
const skillContent = (text = 'Siparişi faturayla eşle; eşleşmeyeni onaya gönder.') => ({ name: 'Fatura eşleştirme', text });
const defineSkill = (commandId: string, skillId = 'invoice-match', expectedRevision: number | null = null, scopeId = 's', text?: string) =>
  ({ schemaVersion: 1, scopeId, commandId, skillId, expectedRevision, content: skillContent(text) });
const agentContent = (skills: { skillId: string; revision: number; digest: string }[], parentAgentId: string | null = null) =>
  ({ name: 'Fatura denetçisi', persona: 'Faturaları siparişle eşleştirirsin; emin değilsen onaya gönderirsin.', workClasses: ['code-change'], skills, parentAgentId });
const defineAgent = (commandId: string, agentId: string, content: ReturnType<typeof agentContent>, expectedRevision: number | null = null, scopeId = 's') =>
  ({ schemaVersion: 1, scopeId, commandId, agentId, expectedRevision, content });
const signed = (skillId: string, content: ReturnType<typeof skillContent>, key = vendor.privateKey, keyId = 'vendor-1') => {
  const digest = skillContentDigest(content);
  return { pin: digest, signature: { algorithm: 'ed25519' as const, keyId, value: sign(null, Buffer.from(skillSignatureMessage({ skillId, contentDigest: digest })), key).toString('base64') } };
};
const importSkill = (commandId: string, bundle: { pin: string | null; signature: ReturnType<typeof signed>['signature'] | null }, content = skillContent(), skillId = 'invoice-match') =>
  ({ schemaVersion: 1, scopeId: 's', commandId, skillId, expectedRevision: null, content, source: { ref: 'hub:verhex/invoice-match' }, ...bundle });

describe('agents and skills: versioned rows, pins and the content-addressed skill set', () => {
  it('a local skill is pinned by its digest; an agent pins it; the skill set digest is content-addressed (order-free); a replay is idempotent', async () => {
    const { app } = await fixture();
    const skill = await app.defineSkill(defineSkill('k1'));
    expect(skill.item).toMatchObject({ revision: 1, contentDigest: skillContentDigest(skillContent()), source: { kind: 'local' }, signature: { status: 'unsigned' } });
    await app.defineSkill(defineSkill('k2', 'po-check'));
    const po = await app.inspectSkill({ schemaVersion: 1, scopeId: 's', skillId: 'po-check' });
    const refs = [{ skillId: 'invoice-match', revision: 1, digest: skill.item.contentDigest }, { skillId: 'po-check', revision: 1, digest: po.status === 'ok' ? po.item.contentDigest : '' }];
    const made = await app.defineAgent(defineAgent('a1', 'invoice-auditor', agentContent(refs)));
    expect(made).toMatchObject({ replayed: false, item: { revision: 1, tier: null, skillSetDigest: skillSetDigest(refs) } });
    expect(skillSetDigest([...refs].reverse())).toBe(skillSetDigest(refs));
    expect(skillSetDigest(refs.slice(0, 1))).not.toBe(skillSetDigest(refs));
    expect(await app.defineAgent(defineAgent('a1', 'invoice-auditor', agentContent(refs)))).toMatchObject({ replayed: true, item: { revision: 1 } });
    await expect(app.defineAgent(defineAgent('a1', 'invoice-auditor', agentContent(refs.slice(0, 1))))).rejects.toMatchObject({ code: 'AGENT_CATALOG_COMMAND_CONFLICT' });
    // Revising a skill never moves an agent's pin.
    await app.defineSkill(defineSkill('k3', 'invoice-match', 1, 's', 'Yeni metin.'));
    const view = await app.inspectAgent({ schemaVersion: 1, scopeId: 's', agentId: 'invoice-auditor' });
    expect(view.status === 'ok' && view.item.content.skills[0]).toEqual(refs[0]);
  });
  it('negative: revision compare-and-set — create of an existing id, a stale revision and a revision of an unknown agent are refused', async () => {
    const { app } = await fixture();
    await app.defineAgent(defineAgent('a1', 'lead', agentContent([])));
    await expect(app.defineAgent(defineAgent('a2', 'lead', agentContent([])))).rejects.toMatchObject({ code: 'AGENT_CATALOG_EXISTS' });
    expect(await app.defineAgent(defineAgent('a3', 'lead', { ...agentContent([]), name: 'Baş denetçi' }, 1))).toMatchObject({ item: { revision: 2 } });
    await expect(app.defineAgent(defineAgent('a4', 'lead', agentContent([]), 1))).rejects.toMatchObject({ code: 'AGENT_CATALOG_REVISION_CONFLICT' });
    await expect(app.defineAgent(defineAgent('a5', 'ghost', agentContent([]), 1))).rejects.toMatchObject({ code: 'AGENT_CATALOG_NOT_FOUND' });
    await expect(app.defineSkill(defineSkill('k1', 'invoice-match', 3))).rejects.toMatchObject({ code: 'AGENT_CATALOG_NOT_FOUND' });
    const view = await app.inspectAgent({ schemaVersion: 1, scopeId: 's', agentId: 'lead' });
    expect(view.status === 'ok' && view.history.map(row => row.revision)).toEqual([1, 2]);
  });
  it('negative: a skill reference that is not an exact pinned revision of this scope is refused', async () => {
    const { app } = await fixture();
    const skill = (await app.defineSkill(defineSkill('k1'))).item;
    await app.defineSkill(defineSkill('k2', 'elsewhere', null, 'other'));
    for (const ref of [{ skillId: 'invoice-match', revision: 2, digest: skill.contentDigest }, { skillId: 'invoice-match', revision: 1, digest: 'f'.repeat(64) },
      { skillId: 'unknown', revision: 1, digest: skill.contentDigest }, { skillId: 'elsewhere', revision: 1, digest: skill.contentDigest }])
      await expect(app.defineAgent(defineAgent(`a-${ref.skillId}-${ref.revision}`, 'x', agentContent([ref])))).rejects.toMatchObject({ code: 'AGENT_SKILL_NOT_PINNED' });
    expect(await app.listAgents({ schemaVersion: 1, scopeId: 's', limit: 10 })).toMatchObject({ items: [] });
  });
  it('negative: a WorkClass the registry does not name is refused (a definition carries requirements; assignment picks the model)', async () => {
    const { app } = await fixture(human, { workClassIds: async () => ['review'] });
    await expect(app.defineAgent(defineAgent('a1', 'x', agentContent([])))).rejects.toMatchObject({ code: 'AGENT_WORK_CLASS_UNKNOWN' });
    expect(await app.defineAgent(defineAgent('a2', 'x', { ...agentContent([]), workClasses: ['review'] }))).toMatchObject({ item: { revision: 1 } });
  });
});

describe('org tree in the store transaction', () => {
  it('negative: a missing or other-scope parent, a depth over the registry bound and a cycle made by a later revision are refused', async () => {
    const { app } = await fixture();
    await expect(app.defineAgent(defineAgent('a0', 'child', agentContent([], 'ghost')))).rejects.toMatchObject({ code: 'AGENT_PARENT_NOT_FOUND' });
    await app.defineAgent(defineAgent('o1', 'boss', agentContent([]), null, 'other'));
    await expect(app.defineAgent(defineAgent('a1', 'child', agentContent([], 'boss')))).rejects.toMatchObject({ code: 'AGENT_PARENT_NOT_FOUND' });
    const max = AGENT_CATALOG_LIMITS.orgTreeDepthMax;
    for (let level = 1; level <= max; level++) await app.defineAgent(defineAgent(`d${level}`, `n${level}`, agentContent([], level === 1 ? null : `n${level - 1}`)));
    await expect(app.defineAgent(defineAgent('deep', 'too-deep', agentContent([], `n${max}`)))).rejects.toMatchObject({ code: 'AGENT_ORG_DEPTH' });
    // n1 is the root; making it report to n2 would close a loop. The application does not pre-check the tree: the store's write transaction refuses it
    // against the rows it holds at commit (two revisions each valid against an older tree cannot both land).
    await expect(app.defineAgent(defineAgent('loop', 'n1', agentContent([], 'n2'), 1))).rejects.toMatchObject({ code: 'AGENT_ORG_CYCLE' });
    const root = await app.inspectAgent({ schemaVersion: 1, scopeId: 's', agentId: 'n1' });
    expect(root.status === 'ok' && root.item).toMatchObject({ revision: 1, content: { parentAgentId: null } });
  });
});

describe('scope isolation', () => {
  it('rows of one scope never answer another, and a scope outside the principal is refused', async () => {
    const { app } = await fixture({ ...human, scopeIds: ['s'] });
    await app.defineSkill(defineSkill('k1'));
    expect(await app.inspectSkill({ schemaVersion: 1, scopeId: 's', skillId: 'invoice-match' })).toMatchObject({ status: 'ok' });
    await expect(app.listSkills({ schemaVersion: 1, scopeId: 'other', limit: 5 })).rejects.toThrow();
    await expect(app.defineSkill(defineSkill('k2', 'invoice-match', null, 'other'))).rejects.toThrow();
  });
});

describe('import hard floor (d): unpinned or unsigned skills are refused for every principal, whatever policy allows', () => {
  for (const [name, principal] of [['a person', human], ['the AI (MCP actor)', mcp]] as const) {
    it(`negative: ${name} — no pin, a wrong pin, no signature, a bad or untrusted signature, or no verifier: nothing is written`, async () => {
      const { app } = await fixture(principal, { verifySkillSignature: trusted });
      const good = signed('invoice-match', skillContent());
      await expect(app.importSkill(importSkill('i1', { ...good, pin: null }))).rejects.toMatchObject({ code: 'SKILL_IMPORT_UNPINNED' });
      await expect(app.importSkill(importSkill('i2', { ...good, pin: 'e'.repeat(64) }))).rejects.toMatchObject({ code: 'SKILL_IMPORT_PIN_MISMATCH' });
      await expect(app.importSkill(importSkill('i3', { ...good, signature: null }))).rejects.toMatchObject({ code: 'SKILL_IMPORT_UNSIGNED' });
      // Signed by a key nobody trusts; signed by the trusted key over other bytes; a signature for another skill id.
      await expect(app.importSkill(importSkill('i4', signed('invoice-match', skillContent(), stranger.privateKey, 'stranger')))).rejects.toMatchObject({ code: 'SKILL_IMPORT_SIGNATURE_UNVERIFIED' });
      await expect(app.importSkill(importSkill('i5', { pin: good.pin, signature: signed('invoice-match', skillContent('başka')).signature }))).rejects.toMatchObject({ code: 'SKILL_IMPORT_SIGNATURE_UNVERIFIED' });
      await expect(app.importSkill(importSkill('i6', signed('other-skill', skillContent())))).rejects.toMatchObject({ code: 'SKILL_IMPORT_SIGNATURE_UNVERIFIED' });
      const unwired = await fixture(principal);
      await expect(unwired.app.importSkill(importSkill('i7', good))).rejects.toMatchObject({ code: 'SKILL_IMPORT_SIGNATURE_UNVERIFIED' });
      expect(await app.listSkills({ schemaVersion: 1, scopeId: 's', limit: 10 })).toMatchObject({ items: [] });
    });
  }
  it('positive twin: a pinned skill signed by a trusted key over exactly (id, content digest) is imported with its verified signature', async () => {
    const { app } = await fixture(human, { verifySkillSignature: trusted });
    const made = await app.importSkill(importSkill('i1', signed('invoice-match', skillContent())));
    expect(made.item).toMatchObject({ revision: 1, source: { kind: 'import', ref: 'hub:verhex/invoice-match' }, signature: { status: 'verified', keyId: 'vendor-1' },
      contentDigest: skillContentDigest(skillContent()), provenance: { author: { ai: false } } });
  });
});

describe('audit', () => {
  it('each transition records one audit event with digests and never the persona or skill text', async () => {
    const { app, path } = await fixture();
    const skill = (await app.defineSkill(defineSkill('k1'))).item;
    const made = (await app.defineAgent(defineAgent('a1', 'lead', agentContent([{ skillId: 'invoice-match', revision: 1, digest: skill.contentDigest }])))).item;
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const records = db.prepare("SELECT record FROM audit_events WHERE kind='agent-catalog' ORDER BY sequence").all().map(row => String(row['record']));
      expect(records).toHaveLength(2);
      expect(records.join('\n')).not.toContain('onaya gönder'); expect(records.join('\n')).not.toContain('eşleştirirsin');
      expect(records[0]).toContain(skill.contentDigest); expect(records[1]).toContain(made.skillSetDigest); expect(records[1]).toContain(made.personaDigest);
    } finally { db.close(); }
  });
});
