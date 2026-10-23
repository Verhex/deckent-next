import { describe, expect, it } from 'vitest';
import { aiAuthorityFloor, agentStandingSchema, catalogAggregatorPrincipal, catalogAggregatorPrincipalRef, defineAgentRevision, initialAgentStandings, isAiPrincipal, isWorkloadPrincipalRef,
  transitionAgentStanding, type AgentStanding } from '#domain/index.js';

// S8-4 (S8-DESIGN §7, §8; owner Q-S12 round 2): an AI/system principal moves a standing only with a signature mark verified at commit; the self-approval
// guard stays versioned code — a suggestion's producer never decides it and an AI never promotes or restores a revision it authored (another signed,
// granted AI may: "yazan AI: X, terfi eden AI: Y"). Only the aggregator's signed rule narrows.
const d = (c: string) => c.repeat(64);
const person = { issuer: 'local-os', subject: 'uid:1000', ai: false }, mcp = { issuer: 'local-os/mcp', subject: 'uid:1000', ai: true };
const other = { issuer: 'remote-ai', subject: 'agent-7', ai: true }, aggregator = { ...catalogAggregatorPrincipalRef({ issuer: 'local-os', subject: 'uid:1000' }), ai: true };
const sig = { keyId: d('e'), signatureDigest: d('f') };
const start = (author: { issuer: string; subject: string } = { issuer: 'local-os', subject: 'uid:1000' }) => {
  const agent = defineAgentRevision(null, { scopeId: 's', agentId: 'auditor', commandId: 'c1', content: { name: 'A', persona: 'P', workClasses: ['feature'], skills: [], parentAgentId: null },
    personaDigest: d('b'), skillSetDigest: d('c'), author: { ...author, assurance: 'os-user' }, atMs: 5, ...(author.issuer.endsWith('/mcp') ? { signed: sig } : {}) });
  return initialAgentStandings(agent, null, false)[0]!;
};
const move = (row: AgentStanding, input: Partial<Parameters<typeof transitionAgentStanding>[1]>) => transitionAgentStanding(row, { action: 'promote', expectedStandingRevision: row.standingRevision,
  actor: person, atMs: 10, commandId: 'k', suggestionId: null, ...input });

describe('signed AI standing path', () => {
  it('N1: an AI command without a signature mark is refused; with one it moves the standing and the basis is `signed` with the key and signature digest', () => {
    expect(() => move(start(), { actor: mcp })).toThrow(expect.objectContaining({ code: 'AGENT_STANDING_REFUSED' }));
    const [row] = move(start(), { actor: mcp, signed: sig });
    expect(row).toMatchObject({ standing: 'active', basis: { kind: 'signed', decidedBy: mcp, signed: sig, commandId: 'k' } });
    expect(agentStandingSchema.safeParse(row).success).toBe(true);
  });
  it('negative: a person\'s card never carries a signature mark; a signed basis without its mark is no valid row', () => {
    expect(() => move(start(), { actor: person, signed: sig })).toThrow(expect.objectContaining({ code: 'AGENT_STANDING_REFUSED' }));
    const [row] = move(start(), { actor: mcp, signed: sig });
    expect(agentStandingSchema.safeParse({ ...row, basis: { ...row!.basis, signed: undefined } }).success).toBe(false);
    expect(agentStandingSchema.safeParse({ ...row, basis: { ...row!.basis, kind: 'person-card' } }).success).toBe(false);
  });
  it('N24/N42: an AI never promotes or restores a revision it authored; another signed AI may (Q-S12); the suggestion producer never decides it', () => {
    const own = start({ issuer: mcp.issuer, subject: mcp.subject });
    expect(() => move(own, { actor: mcp, signed: sig, author: mcp })).toThrow(expect.objectContaining({ code: 'AGENT_STANDING_REFUSED' }));
    expect(move(own, { actor: other, signed: sig, author: mcp })[0]).toMatchObject({ standing: 'active', basis: { decidedBy: other } });
    // Demoting or retiring its own revision is no self-approval.
    const active = move(own, { actor: other, signed: sig, author: mcp })[0]!;
    expect(move(active, { action: 'demote', actor: mcp, signed: sig, author: mcp })[0]!.standing).toBe('candidate');
    for (const actor of [aggregator, person]) expect(() => move(start(), { actor, ...(actor.ai ? { signed: sig } : {}), suggestionId: d('a'), producer: actor }))
      .toThrow(expect.objectContaining({ code: 'AGENT_STANDING_REFUSED' }));
  });
  it('N3/N4: narrowing needs a sealed suggestion and the aggregator\'s signature; it only narrows (a rule never widens)', () => {
    expect(() => move(start(), { action: 'narrow', actor: aggregator, commandId: null, suggestionId: d('a') })).toThrow(expect.objectContaining({ code: 'AGENT_STANDING_REFUSED' }));
    expect(() => move(start(), { action: 'narrow', actor: aggregator, commandId: null, suggestionId: null, signed: sig })).toThrow(expect.objectContaining({ code: 'AGENT_STANDING_REFUSED' }));
    const [narrowed] = move(start(), { action: 'narrow', actor: aggregator, commandId: null, suggestionId: d('a'), signed: sig, producer: aggregator, reasonCode: 'redesign-agent' });
    expect(narrowed).toMatchObject({ standing: 'redesign-required', basis: { kind: 'rule', suggestionId: d('a'), signed: sig } });
    expect(() => move(narrowed!, { action: 'narrow', actor: aggregator, commandId: null, suggestionId: d('b'), signed: sig })).toThrow(expect.objectContaining({ code: 'AGENT_STANDING_REFUSED' }));
  });
});

describe('the catalog aggregator principal (S8-3 §9)', () => {
  const owner = { issuer: 'local-os', subject: 'uid:1000' }, principal = catalogAggregatorPrincipal(owner, ['s']);
  it('is a workload identity and AI whatever its assurance; held to its exact allow-list', () => {
    expect(principal).toMatchObject({ issuer: 'local-os/catalog-aggregator', assurance: 'workload-verified' });
    expect(isWorkloadPrincipalRef(principal) && isAiPrincipal({ ...principal, assurance: 'os-user' })).toBe(true);
    for (const [kind, action] of [['agent-catalog', 'inspect'], ['agent-catalog', 'suggest'], ['agent-catalog', 'narrow'], ['run', 'inspect'], ['memory', 'inspect']] as const)
      expect(aiAuthorityFloor(principal, { kind, id: 's' }, action), `${kind}/${action}`).toBe(false);
    for (const [kind, action] of [['agent-catalog', 'promote'], ['agent-catalog', 'define'], ['agent-catalog', 'import'], ['agent-catalog', 'dismiss'], ['skill-signer', 'enrol'],
      ['memory', 'propose'], ['attempt', 'read-output'], ['config', 'write'], ['run', 'create']] as const) expect(aiAuthorityFloor(principal, { kind, id: 's' }, action), `${kind}/${action}`).toBe(true);
  });
  it('N2/N4: only the aggregator suggests or narrows — every other AI is refused whatever is granted; a person is not floored', () => {
    for (const issuer of ['local-os/mcp', 'local-os/auditor', 'local-os/nervous', 'local-os/memory-distiller', 'local-os/memory-evaluator', 'local-os/recovery'])
      for (const action of ['suggest', 'narrow']) expect(aiAuthorityFloor({ issuer, assurance: 'os-user' }, { kind: 'agent-catalog', id: 's' }, action), `${issuer}/${action}`).toBe(true);
    for (const issuer of ['local-os/auditor', 'local-os/nervous', 'local-os/memory-distiller', 'local-os/memory-evaluator', 'local-os/recovery'])
      for (const action of ['define', 'import', 'promote', 'demote', 'restore', 'retire', 'dismiss'])
        expect(aiAuthorityFloor({ issuer, assurance: 'workload-verified' }, { kind: 'agent-catalog', id: 's/feature' }, action), `${issuer}/${action}`).toBe(true);
    expect(aiAuthorityFloor({ issuer: 'local-os', assurance: 'os-user' }, { kind: 'agent-catalog', id: 's' }, 'suggest')).toBe(false);
  });
});
