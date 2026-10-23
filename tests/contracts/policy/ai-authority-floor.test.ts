import { expect, it } from 'vitest';
import { aiAuthorityFloor, evaluatePolicy, getPolicyVocabulary, type VerifiedPrincipal } from '#domain/index.js';

const human: VerifiedPrincipal = { id: 'owner', issuer: 'host', subject: '1000', assurance: 'os-user', scopeIds: ['s'] };
const mcp: VerifiedPrincipal = { ...human, id: 'mcp', issuer: 'host/mcp', assurance: 'workload-verified' };
const legacyMcp: VerifiedPrincipal = { ...mcp, assurance: 'os-user' };
const workload: VerifiedPrincipal = { ...human, id: 'script', issuer: 'ci', assurance: 'workload-verified' };
/** Every route that can widen an AI actor's own (or a controlled principal's) authority, against the vocabulary and administration commands. */
const WIDENING: readonly (readonly [string, string, string, string])[] = [
  ['grants, role bindings, delegation cells, restrictions, SoD, standing grants', 'operation', 'policy.administer', 'execute'],
  ['policy administration compensation', 'operation', 'policy.administer', 'compensate'],
  ['authority document write', 'authority-document', 'policy', 'write'],
  ['authenticator record', 'authenticator', 'local-os', 'register'],
  ['assurance level record', 'approval-assurance', 'core.turn-bound@1', 'activate'],
  ['permission mode', 'permission-mode', 'full-auto', 'set'],
  ['full access', 'permission-mode', 'full-access', 'set'],
  ['backup restore of authority', 'backup', 'set', 'restore'],
  // Owner 2026-10-19 (I-POL v13): host changes outside the sandbox stay a person's at a terminal.
  ['execution environment install (Docker group is root-equivalent)', 'execution-environment', 'docker', 'install'],
  ['installation repair (doctor fix of the installation itself)', 'installation', 'installation-directory-private', 'repair'],
  ['secret write', 'secret', 'OPENAI_API_KEY', 'set'],
  ['secret delete', 'secret', 'OPENAI_API_KEY', 'delete'],
  ['secret store switch', 'secret', 'all', 'switch'],
  ['secret read', 'secret', 'OPENAI_API_KEY', 'read'],
  ['secret resolve', 'secret', 'OPENAI_API_KEY', 'resolve'],
  ['identity profile distribution card', 'approval', 'identity-profile', 'decide'],
  ['MCP capability / trust grant card', 'approval', 'policy-mcp-capability', 'decide'],
  ['template upgrade / rollback card', 'approval', 'policy-template-upgrade', 'decide'],
  ['audit checkpoint re-baseline', 'audit', 's', 'rebaseline'],
  ['audit checkpoint re-baseline command (its authority cell)', 'approval', 'audit-rebaseline', 'decide'],
  ['secret-gate exclusion globs', 'config', 'project:execution.secretGate.allowPatternPaths', 'write'],
  // S4 (law-audit fold 6): verified memory is a person's or an independent evaluation's, never the AI's; retiring is the same change.
  ['memory verify', 'memory', 'scope', 'verify'],
  ['memory retire', 'memory', 'scope', 'retire'],
  // S4B-1 (A11): purging memory content is a person's act; a contest stays floored until S4B-3 relaxes it for the evaluator principal alone.
  ['memory purge', 'memory', 'scope', 'purge'],
  ['memory contest', 'memory', 'scope', 'contest'],
  // S6R-3 (lead on s6 Q3): the owner's standing approval of a Nervous stop action is never an AI's.
  ['Nervous standing approval', 'recovery-action', 'stop-orphan', 'apply'],
  ['secret-gate acknowledged deny paths', 'config', 'global:execution.secretGate.acknowledgedDenyPaths', 'write'],
  ['secret-gate section', 'config', 'project:execution.secretGate', 'write'],
  ['approval assurance producers', 'config', 'project:approvals.assuranceProducers', 'write'],
  ['policy config', 'config', 'project:policy', 'write'],
  ['identity config', 'config', 'global:identity.profile', 'write'],
  // REVIEW2561 R1: the real terminal boundary keys (adapters/core/contract terminal schema) and every parent whose whole-object write replaces them.
  ['agent shell realm (require-sandbox -> host)', 'config', 'project:terminal.shell.realm', 'write'],
  ['agent shell environment pass-through', 'config', 'project:terminal.shell.environment', 'write'],
  ['agent shell environment entry', 'config', 'global:terminal.shell.environment[0]', 'write'],
  ['agent fetch egress', 'config', 'project:terminal.fetch.egress', 'write'],
  ['agent fetch host allowlist', 'config', 'global:terminal.fetch.allowedHosts', 'write'],
  ['whole terminal.shell object', 'config', 'project:terminal.shell', 'write'],
  ['whole terminal.fetch object', 'config', 'project:terminal.fetch', 'write'],
  ['whole terminal object', 'config', 'project:terminal', 'write'],
  ['Docker isolation', 'config', 'project:execution.docker.network', 'write'],
  ['admission registry', 'config', 'project:admission', 'write'],
  ['operation targets', 'config', 'project:operations.targets', 'write'],
  ['audit monitoring', 'config', 'project:audit.checkpointIntervalMs', 'write'],
  ['principal assurance enforcement', 'config', 'project:enforce_principal_assurance', 'write'],
  // S5b (Auditor owner decision 6): a safety hold is a person's to lift; the public operator hold stays policy-governed (run-decision resume).
  ['Nervous pause resume', 'run-hold', 'nervous', 'resume'],
  ['Auditor park resume', 'run-hold', 'auditor', 'resume'],
];
const grantAll = (kind: string, principal: VerifiedPrincipal) => ({ id: `all-${kind}`, effect: 'allow' as const, actions: 'all' as const, scopes: 'all' as const,
  principals: [{ issuer: principal.issuer, subject: principal.subject }], resource: { kind, ids: 'all' as const } });
const policyFor = (principal: VerifiedPrincipal) => ({ schemaVersion: 1, revision: 'p', restrictions: [],
  grants: [...new Set(WIDENING.map(row => row[1]))].map(kind => grantAll(kind, principal)) });

it.each(WIDENING)('%s is refused for every AI actor even when a policy cell grants it (%s %s %s)', (_label, kind, id, action) => {
  for (const ai of [mcp, legacyMcp, workload]) {
    expect(aiAuthorityFloor(ai, { kind, id }, action), ai.id).toBe(true);
    expect(evaluatePolicy(policyFor(ai), { principal: ai, scopeId: 's', action, resource: { kind, id } }), ai.id).toMatchObject({ decision: 'deny', reason: 'AI_NON_DELEGABLE' });
  }
  // The same grant works for a human: the refusal is the floor, not a missing grant.
  expect(evaluatePolicy(policyFor(human), { principal: human, scopeId: 's', action, resource: { kind, id } }).decision).toBe('allow');
});

it('every vocabulary action that is not authority-widening stays policy-governed for AI', () => {
  const widening = new Set(WIDENING.map(([, kind, , action]) => `${kind}:${action}`));
  const governed = getPolicyVocabulary().resources.flatMap(resource => resource.actions.map(action => `${resource.kind}:${action}`))
    .filter(cell => !widening.has(cell) && !['backup:restore', 'permission-mode:set'].includes(cell) && !cell.startsWith('secret:'));
  for (const cell of governed) {
    const [kind, action] = cell.split(':') as [string, string];
    expect(aiAuthorityFloor(mcp, { kind, id: 'ordinary-target' }, action), cell).toBe(false);
  }
  expect(aiAuthorityFloor(mcp, { kind: 'audit', id: 's' }, 'verify')).toBe(false);
  expect(aiAuthorityFloor(mcp, { kind: 'approval', id: 'ordinary-uuid' }, 'decide')).toBe(false);
  for (const key of ['terminal.theme', 'terminal.shell.timeoutMs', 'terminal.fetch.timeoutMs', 'terminal.chat', 'terminal.scratch.retentionDays', 'language', 'max_workers'])
    expect(aiAuthorityFloor(mcp, { kind: 'config', id: `project:${key}` }, 'write'), key).toBe(false);
});
