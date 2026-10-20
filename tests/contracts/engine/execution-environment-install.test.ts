import { describe, expect, it } from 'vitest';
import { auditEventSchema, firstRunPolicyTemplate, mcpPrincipalRef, resolvePolicyBindings, type AuditEvent, type PolicyGrant } from '#domain/index.js';
import { ExecutionEnvironmentInstallApplication, FIRST_RUN_TOOL_NAMES, policyExecutionInstallAuthorization, type ExecutionInstallOutcome } from '#engine/index.js';

// I-D2 (INIT-D2 cond. 4): the one owner of the approved host install: policy (installation-wide v13 grant) → refused audit + typed refusal,
// or the person's card → intent before the effect → the effect's end; a thrown effect is `uncertain`; nothing is retried.
const person = { issuer: 'host', subject: '1000' };
const built = firstRunPolicyTemplate({ scopeId: 'installation', principal: person, ...FIRST_RUN_TOOL_NAMES });
const policy = resolvePolicyBindings(built.policy, built.bindings);
const principal = { id: 'owner@host', ...person, assurance: 'os-user' as const };
const request = (who = principal, environment = 'docker') => ({ environment, scopeId: 'installation', principal: who, source: { distribution: 'ubuntu', codename: 'noble',
  fingerprint: '9DC858229FC7DD38854AE2D88D81803C0EBFCD88' } });
const succeeded: ExecutionInstallOutcome = { status: 'succeeded', step: null, exitCode: 0, version: '5:29.0.0-1~ubuntu.24.04~noble' };
function harness(document: unknown = policy) {
  const events: AuditEvent[] = [], calls: string[] = [];
  const owner = new ExecutionEnvironmentInstallApplication(policyExecutionInstallAuthorization(document), async event => { events.push(auditEventSchema.parse(event)); }, () => 1);
  const effect = (confirm: boolean, apply: () => Promise<ExecutionInstallOutcome> = async () => succeeded) => ({
    confirm: async () => { calls.push('confirm'); return confirm; }, apply: async () => { calls.push('apply'); return apply(); } });
  const phases = () => events.map(event => event.subject.kind === 'execution-environment-install' ? event.subject.phase : event.subject.kind);
  return { owner, effect, events, calls, phases };
}

describe('execution-environment install owner (engine/core/setup)', () => {
  it('the v13 person: card → intent before the effect → succeeded with the resolved version; no secret or command in the audit', async () => {
    const { owner, effect, events, calls, phases } = harness();
    expect(await owner.install(request(), effect(true))).toEqual(succeeded);
    expect(calls).toEqual(['confirm', 'apply']);
    expect(phases()).toEqual(['intent', 'succeeded']);
    expect(events[1]?.subject).toMatchObject({ environment: 'docker', version: succeeded.version, exitCode: 0, step: null,
      source: { distribution: 'ubuntu', codename: 'noble' }, decision: { effect: 'allow', ruleId: 'first-run-execution-environment-install' } });
    expect(events[0]?.subject).toMatchObject({ operationId: (events[1]?.subject as { operationId: string }).operationId });
    expect(JSON.stringify(events)).not.toMatch(/sudo|apt-get|password|usermod/u);
  });
  it('declined on the card: nothing ran and nothing was recorded as started', async () => {
    const { owner, effect, calls, phases } = harness();
    expect(await owner.install(request(), effect(false))).toBe('declined');
    expect(calls).toEqual(['confirm']);
    expect(phases()).toEqual([]);
  });
  it('a failed step and an interrupted effect are recorded as they ended; a thrown effect is uncertain and rethrown (no retry)', async () => {
    const failed: ExecutionInstallOutcome = { status: 'failed', step: 4, exitCode: 100, version: null };
    const a = harness();
    expect(await a.owner.install(request(), a.effect(true, async () => failed))).toEqual(failed);
    expect(a.phases()).toEqual(['intent', 'failed']);
    expect(a.events[1]?.subject).toMatchObject({ step: 4, exitCode: 100 });
    const b = harness();
    await expect(b.owner.install(request(), b.effect(true, async () => { throw new Error('host lost'); }))).rejects.toThrow('host lost');
    expect(b.phases()).toEqual(['intent', 'uncertain']);
    expect(b.calls).toEqual(['confirm', 'apply']);
  });
  it('refusals before the card: no grant, a scoped grant, another environment, the MCP actor and a colleague are refused and audited; nothing is asked or run', async () => {
    const scoped = { ...policy, grants: policy.grants.map((rule: PolicyGrant) => rule.id === 'first-run-execution-environment-install' ? { ...rule, scopes: ['installation'] } : rule) };
    const without = { ...policy, grants: policy.grants.filter((rule: PolicyGrant) => rule.id !== 'first-run-execution-environment-install') };
    // Even an explicit grant naming the MCP actor is floored (AI authority floor, owner 2026-10-19).
    const mcp = { ...principal, ...mcpPrincipalRef(person), assurance: 'workload-verified' as const };
    const grantedMcp = { ...policy, grants: [...policy.grants, { id: 'mcp-install', effect: 'allow', actions: ['install'], scopes: 'all', principals: [mcpPrincipalRef(person)],
      resource: { kind: 'execution-environment', ids: 'all' } }] };
    const cases: Array<[unknown, typeof principal, string]> = [[without, principal, 'docker'], [scoped, principal, 'docker'], [policy, principal, 'podman'],
      [grantedMcp, mcp, 'docker'], [policy, { ...principal, id: 'colleague', subject: '1001' }, 'docker']];
    for (const [document, who, environment] of cases) {
      const { owner, effect, calls, phases, events } = harness(document);
      await expect(owner.install(request(who, environment), effect(true))).rejects.toMatchObject({ code: 'SETUP_INSTALL_DENIED' });
      expect(calls).toEqual([]);
      expect(phases()).toEqual(['refused']);
      expect(events[0]?.subject).toMatchObject({ decision: { effect: 'deny' } });
    }
  });
});
