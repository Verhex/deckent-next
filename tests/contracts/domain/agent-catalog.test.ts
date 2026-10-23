import { describe, expect, it } from 'vitest';
import { AGENT_CATALOG_LIMITS, AgentCatalogError, agentDefinitionSchema, checkAgentOrgTree, defineAgentRevision, defineSkillRevision,
  requireSkillImportPinnedAndSigned, requireSkillSignatureVerified, skillDefinitionSchema } from '#domain/index.js';

// S7 agent/skill catalog core (owner ORG, AJAN-ORG 2026-10-16 S1/S2/S4/S6, A4, ASS1). Pure rules: versioned rows, an empty tier, an org tree
// bounded by limits data, and the hard floor (d) "no unpinned or unsigned skill import" in versioned code with no policy or config input (e).
const person = { issuer: 'local-os', subject: 'uid:1000', assurance: 'os-user' }, ai = { issuer: 'local-os/mcp', subject: 'uid:1000', assurance: 'os-user' };
const d = (c: string) => c.repeat(64);
const content = { name: 'Fatura denetçisi', persona: 'Faturaları siparişle eşleştirir; eşleşmeyeni onaya gönderir.', workClasses: ['code-change'],
  skills: [{ skillId: 'invoice-match', revision: 1, digest: d('a') }], parentAgentId: null };
const agent = (previous: Parameters<typeof defineAgentRevision>[0], extra: Partial<typeof content> = {}) => defineAgentRevision(previous, { scopeId: 's',
  agentId: 'invoice-auditor', commandId: 'c1', content: { ...content, ...extra }, personaDigest: d('b'), skillSetDigest: d('c'), author: person, atMs: 5 });
const tree = (rows: Record<string, string | null>) => new Map(Object.entries(rows));

describe('agent definition rows', () => {
  it('a new agent is revision 1 with an empty tier; a revision keeps the id and carries the author (AI flag) and the content digests', () => {
    const first = agent(null);
    expect(first).toMatchObject({ schemaVersion: 1, revision: 1, tier: null, personaDigest: d('b'), skillSetDigest: d('c'), provenance: { author: { ai: false }, commandId: 'c1' } });
    const second = defineAgentRevision(first, { scopeId: 's', agentId: 'invoice-auditor', commandId: 'c2', content: { ...content, name: 'Fatura denetçisi 2' },
      personaDigest: d('b'), skillSetDigest: d('c'), author: ai, atMs: 6 });
    expect(second).toMatchObject({ revision: 2, content: { name: 'Fatura denetçisi 2' }, provenance: { author: { ai: true } } });
  });
  it('negative: the tier cannot be set (A4: it opens empty, tier grants nothing), a parent cannot be itself, and bounds come from limits data', () => {
    expect(agentDefinitionSchema.safeParse({ ...agent(null), tier: 'senior' }).success).toBe(false);
    expect(() => agent(null, { parentAgentId: 'invoice-auditor' })).toThrow(expect.objectContaining({ code: 'AGENT_ORG_CYCLE' }));
    expect(() => agent(null, { persona: 'x'.repeat(AGENT_CATALOG_LIMITS.personaMaxBytes + 1) })).toThrow(expect.objectContaining({ code: 'AGENT_DEFINITION_INVALID' }));
    expect(() => agent(null, { workClasses: [] })).toThrow(expect.objectContaining({ code: 'AGENT_DEFINITION_INVALID' }));
    const many = Array.from({ length: AGENT_CATALOG_LIMITS.skillsPerAgentMax + 1 }, (_, i) => ({ skillId: `s${i}`, revision: 1, digest: d('a') }));
    expect(() => agent(null, { skills: many })).toThrow(expect.objectContaining({ code: 'AGENT_DEFINITION_INVALID' }));
    expect(() => agent(null, { skills: [content.skills[0]!, { ...content.skills[0]!, revision: 2 }] })).toThrow(expect.objectContaining({ code: 'AGENT_DEFINITION_INVALID' }));
    // Requirements only (AJAN-ORG S2): a definition never names a model.
    expect(() => agent(null, { model: 'claude-opus-5-5' } as never)).toThrow(expect.objectContaining({ code: 'AGENT_DEFINITION_INVALID' }));
  });
  it('negative: a revision of another agent or scope is refused', () => {
    const first = agent(null);
    expect(() => defineAgentRevision(first, { scopeId: 'other', agentId: 'invoice-auditor', commandId: 'c2', content, personaDigest: d('b'), skillSetDigest: d('c'), author: person, atMs: 6 }))
      .toThrow(expect.objectContaining({ code: 'AGENT_DEFINITION_INVALID' }));
  });
});

describe('org tree (manager agent → reporting agents)', () => {
  it('accepts a forest within the depth bound', () => {
    expect(() => checkAgentOrgTree(tree({ lead: null, a: 'lead', b: 'lead', c: 'a', solo: null }), 3)).not.toThrow();
  });
  it('negative: a cycle, a missing parent and a depth over the bound are each refused with their own code', () => {
    expect(() => checkAgentOrgTree(tree({ a: 'b', b: 'a' }), 8)).toThrow(expect.objectContaining({ code: 'AGENT_ORG_CYCLE' }));
    expect(() => checkAgentOrgTree(tree({ a: 'b', b: 'c', c: 'a', root: null }), 8)).toThrow(expect.objectContaining({ code: 'AGENT_ORG_CYCLE' }));
    expect(() => checkAgentOrgTree(tree({ a: 'ghost' }), 8)).toThrow(expect.objectContaining({ code: 'AGENT_PARENT_NOT_FOUND' }));
    expect(() => checkAgentOrgTree(tree({ r: null, a: 'r', b: 'a', c: 'b' }), 3)).toThrow(expect.objectContaining({ code: 'AGENT_ORG_DEPTH' }));
    expect(() => checkAgentOrgTree(tree({ r: null, a: 'r', b: 'a' }), 3)).not.toThrow();
  });
});

describe('skill rows and the import hard floor (d)', () => {
  const skill = (source: { kind: 'local' } | { kind: 'import'; ref: string }, signature: Parameters<typeof defineSkillRevision>[1]['signature']) =>
    defineSkillRevision(null, { scopeId: 's', skillId: 'invoice-match', commandId: 'k1', content: { name: 'Eşleştirme', text: 'Siparişi faturayla eşle.' },
      contentDigest: d('a'), source, signature, author: person, atMs: 1 });
  it('a local skill is unsigned and pinned by its content digest; an imported one carries its verified signature', () => {
    expect(skill({ kind: 'local' }, { status: 'unsigned' })).toMatchObject({ revision: 1, contentDigest: d('a'), source: { kind: 'local' }, signature: { status: 'unsigned' } });
    expect(skill({ kind: 'import', ref: 'hub:invoice-match' }, { status: 'verified', algorithm: 'ed25519', keyId: 'vendor-1', value: 'c2ln' }))
      .toMatchObject({ source: { kind: 'import' }, signature: { status: 'verified', keyId: 'vendor-1' } });
  });
  it('negative: no imported row can exist without a verified signature, whatever the caller writes', () => {
    expect(() => skill({ kind: 'import', ref: 'hub:invoice-match' }, { status: 'unsigned' })).toThrow(expect.objectContaining({ code: 'SKILL_DEFINITION_INVALID' }));
    const local = skill({ kind: 'local' }, { status: 'unsigned' });
    expect(skillDefinitionSchema.safeParse({ ...local, source: { kind: 'import', ref: 'x' } }).success).toBe(false);
  });
  it('negative: an unpinned, mismatched or unsigned import is refused before any signature check; only a valid verdict passes', () => {
    const signature = { algorithm: 'ed25519' as const, keyId: 'vendor-1', value: 'c2ln' };
    expect(() => requireSkillImportPinnedAndSigned({ declaredDigest: null, computedDigest: d('a'), signature })).toThrow(expect.objectContaining({ code: 'SKILL_IMPORT_UNPINNED' }));
    expect(() => requireSkillImportPinnedAndSigned({ declaredDigest: d('b'), computedDigest: d('a'), signature })).toThrow(expect.objectContaining({ code: 'SKILL_IMPORT_PIN_MISMATCH' }));
    expect(() => requireSkillImportPinnedAndSigned({ declaredDigest: d('a'), computedDigest: d('a'), signature: null })).toThrow(expect.objectContaining({ code: 'SKILL_IMPORT_UNSIGNED' }));
    expect(() => requireSkillImportPinnedAndSigned({ declaredDigest: d('a'), computedDigest: d('a'), signature })).not.toThrow();
    for (const verdict of ['invalid', 'unknown-key', 'unavailable'] as const)
      expect(() => requireSkillSignatureVerified(verdict)).toThrow(expect.objectContaining({ code: 'SKILL_IMPORT_SIGNATURE_UNVERIFIED' }));
    expect(() => requireSkillSignatureVerified('valid')).not.toThrow();
  });
  it('the floor takes no principal, policy or configuration input: its only inputs are the bytes, the pin and the verdict (e)', () => {
    expect(requireSkillImportPinnedAndSigned.length).toBe(1); expect(requireSkillSignatureVerified.length).toBe(1);
    expect(new AgentCatalogError('SKILL_IMPORT_UNSIGNED')).toMatchObject({ name: 'AgentCatalogError', code: 'SKILL_IMPORT_UNSIGNED' });
  });
});
