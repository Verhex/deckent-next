import { describe, expect, it } from 'vitest';
import { resolvePolicyBindings } from '#domain/index.js';
import { decideAgentToolCall, type AgentToolCallCell } from '#engine/index.js';

// FETCH S7 (owner 2026-09-28): a fetch is decided by the one permission function over both sides (`agent-tool/invoke fetch_url` and
// `operation/execute network.fetch`); an allowlisted host keeps the policy decision, a host outside it raises allow to a card, and no
// permission mode ever lowers a fetch (neither cell is relaxable, whatever the company marks eligible).
const me = { issuer: 'host', subject: '1000' };
const principal = { id: 'os:1000', ...me, assurance: 'os-user' as const, scopeIds: ['scope'] };
type Effect = 'allow' | 'deny' | 'require-approval';
const rule = (id: string, kind: string, ids: string[], effect: Effect, eligible = false) => ({ id, effect, actions: kind === 'operation' ? ['execute'] : ['invoke'],
  scopes: ['scope'], principals: [me], resource: { kind, ids }, ...(eligible ? { modeEligible: true } : {}) });
const policyOf = (tool: Effect, operation: Effect, eligible: boolean, mode: string | null) => resolvePolicyBindings(
  { schemaVersion: 2, revision: 'p', roles: [], separationOfDuties: [], restrictions: [],
    grants: [rule('fetch-tool', 'agent-tool', ['fetch_url'], tool, eligible && tool === 'require-approval'),
      rule('fetch-op', 'operation', ['network.fetch'], operation, eligible && operation === 'require-approval')] },
  mode === null ? { schemaVersion: 1, revision: 'b', bindings: [] }
    : { schemaVersion: 2, revision: 'b', bindings: [], modes: [{ id: 'me-mode', principal: me, scopes: ['scope'], mode }] });
const decide = (policy: unknown, cell: AgentToolCallCell) =>
  decideAgentToolCall(policy, { principal, scopeId: 'scope', tool: { name: 'fetch_url' }, operation: { id: 'network.fetch' }, cell });

describe('fetch decision cells (FETCH S7)', () => {
  it('allow on both sides: an allowlisted host is silent, a host outside the allowlist asks', () => {
    const policy = policyOf('allow', 'allow', false, null);
    expect(decide(policy, 'fetch-listed')).toMatchObject({ decision: 'allow', relaxation: null });
    expect(decide(policy, 'fetch-unlisted')).toMatchObject({ decision: 'require-approval', relaxation: null });
  });
  it('a deny on either side ends it before any cell matters', () => {
    for (const [tool, operation] of [['deny', 'allow'], ['allow', 'deny']] as const) {
      for (const cell of ['fetch-listed', 'fetch-unlisted'] as const) expect(decide(policyOf(tool, operation, false, null), cell).decision).toBe('deny');
    }
  });
  it('no permission mode lowers a fetch, even an eligible require-approval in full-auto', () => {
    for (const mode of ['ask', 'auto-edit', 'full-auto']) {
      for (const [tool, operation] of [['require-approval', 'allow'], ['allow', 'require-approval'], ['require-approval', 'require-approval']] as const) {
        for (const cell of ['fetch-listed', 'fetch-unlisted'] as const) {
          expect(decide(policyOf(tool, operation, true, mode), cell)).toMatchObject({ decision: 'require-approval', relaxation: null });
        }
      }
    }
  });
});
