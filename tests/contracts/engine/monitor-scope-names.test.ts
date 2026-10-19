import { describe, expect, it, vi } from 'vitest';
import { MonitorApplication, monitorScopeDiagnosticsAllowed, type MonitorPorts } from '#engine/index.js';

// MON-NAMES (owner 2026-10-19, PLAN §16): one producer. The reader names refused and failed scopes (id and reason) only to a viewer holding the
// installation-wide `monitor inspect-scope-diagnostics` grant; every other viewer, a missing port and a failed decision keep J2's counts.
const NOW = 1_000_000;
const failure = (code: string) => Object.assign(new Error(code), { code });
const SECRETS = /scope-(locked|quiet|refused)/;
const ledger = { ledgerVersion: 44, scopeIds: ['s', 'scope-locked-alpha', 'scope-locked-beta', 'scope-quiet-gamma', 'scope-refused-delta'], diagnostics: [], approvals: [], runs: [], pools: [] };
const COUNTS = ['scopes-denied:1', 'scopes-unavailable:2:LEDGER_LOCKED', 'scopes-unavailable:1'];
const NAMES = ['scope-refused:POLICY_DENIED:scope-refused-delta', 'scope-failed:LEDGER_LOCKED:scope-locked-alpha', 'scope-failed:LEDGER_LOCKED:scope-locked-beta',
  'scope-failed::scope-quiet-gamma'];
function app(observeScopeDiagnostics?: MonitorPorts['observeScopeDiagnostics']) {
  return new MonitorApplication({ now: () => NOW, describeService: async () => { throw failure('LOCAL_RUNTIME_UNAVAILABLE'); }, observePool: async () => true,
    indexLedger: async () => ({ ledgerVersion: 44, scopeIds: ledger.scopeIds, poolIds: [] }), readLedger: async () => ledger,
    async observeScope(_target, scopeId) {
      if (scopeId.startsWith('scope-locked')) throw failure('LEDGER_LOCKED');
      if (scopeId === 'scope-quiet-gamma') return { access: 'unavailable', workers: [], workerStatus: 'unavailable', truncated: false };
      if (scopeId === 'scope-refused-delta') return { access: 'denied', reason: 'POLICY_DENIED', workers: [], workerStatus: 'denied', truncated: false };
      return { access: 'admitted', workers: [], workerStatus: 'available', truncated: false };
    }, ...(observeScopeDiagnostics ? { observeScopeDiagnostics } : {}) });
}
const inspect = async (ports: MonitorApplication) => (await ports.inspect([{ id: 'current', path: '/c' }])).installs[0]!;

describe('monitor scope names (MON-NAMES)', () => {
  it('a viewer holding the grant sees refused and failed scopes by id and reason; the decision is asked once, admitted scopes first', async () => {
    const decide = vi.fn(async () => true), install = await inspect(app(decide));
    expect(install).toMatchObject({ status: 'available', scopeIds: ['s'] });
    expect(install.diagnostics).toEqual(NAMES);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledWith({ id: 'current', path: '/c' }, ['s', 'scope-locked-alpha', 'scope-locked-beta', 'scope-quiet-gamma', 'scope-refused-delta']);
  });

  it('negative: a viewer without the grant keeps the counts; the snapshot (`--json`, MCP) carries no scope id', async () => {
    const install = await inspect(app(async () => false));
    expect(install.diagnostics).toEqual(COUNTS);
    expect(JSON.stringify(install)).not.toMatch(SECRETS);
  });

  it('negative: without the port (SDK fakes, older composition) the reader keeps the counts', async () => {
    const install = await inspect(app());
    expect(install.diagnostics).toEqual(COUNTS);
    expect(JSON.stringify(install)).not.toMatch(SECRETS);
  });

  it('negative: a failed decision is fail-closed — counts, and one reason without any scope id', async () => {
    const install = await inspect(app(async () => { throw failure('POLICY_UNAVAILABLE'); }));
    expect(install.diagnostics).toEqual(['scopes-denied:1', 'scopes-unavailable:2:LEDGER_LOCKED', 'scopes-unavailable:1', 'scope-diagnostics-unavailable:POLICY_UNAVAILABLE']);
    expect(JSON.stringify(install)).not.toMatch(SECRETS);
    // A truthy non-boolean answer is not an allow either.
    expect((await inspect(app(async () => 'yes' as unknown as boolean))).diagnostics).toEqual(COUNTS);
  });

  it('nothing refused or failed: the decision is never asked', async () => {
    const decide = vi.fn(async () => true);
    const quiet = new MonitorApplication({ now: () => NOW, describeService: async () => { throw failure('LOCAL_RUNTIME_UNAVAILABLE'); }, observePool: async () => true,
      indexLedger: async () => ({ ledgerVersion: 44, scopeIds: ['s'], poolIds: [] }), readLedger: async () => ({ ...ledger, scopeIds: ['s'] }),
      observeScope: async () => ({ access: 'admitted', workers: [], workerStatus: 'available', truncated: false }), observeScopeDiagnostics: decide });
    expect((await inspect(quiet)).diagnostics).toEqual([]);
    expect(decide).not.toHaveBeenCalled();
  });
});

describe('the installation-wide grant decision (policy path, no role check)', () => {
  const person = { id: 'p', issuer: 'host', subject: '1000', assurance: 'os-user' as const, scopeIds: ['s'] };
  const mcp = { id: 'p/mcp', issuer: 'host/mcp', subject: '1000', assurance: 'workload-verified' as const, scopeIds: ['s'] };
  const rule = (over: Record<string, unknown> = {}) => ({ id: 'names', effect: 'allow', actions: ['inspect-scope-diagnostics'], scopes: 'all',
    principals: [{ issuer: 'host', subject: '1000' }], resource: { kind: 'monitor', ids: 'all' }, ...over });
  const policy = (...grants: unknown[]) => ({ schemaVersion: 1, revision: 'r', restrictions: [], grants });
  it('allows the person holding the v13 rule (scopes all, ids all)', () => {
    expect(monitorScopeDiagnosticsAllowed(policy(rule()), person)).toBe(true);
  });
  it('negative: no grant, another principal, the MCP actor, a one-scope grant, a deny or an approval rule → no names', () => {
    expect(monitorScopeDiagnosticsAllowed(policy(), person)).toBe(false);
    expect(monitorScopeDiagnosticsAllowed(policy(rule({ principals: [{ issuer: 'host', subject: '1001' }] })), person)).toBe(false);
    expect(monitorScopeDiagnosticsAllowed(policy(rule()), mcp)).toBe(false);
    expect(monitorScopeDiagnosticsAllowed(policy(rule({ principals: 'all' })), mcp)).toBe(false);
    // A grant over one scope would name other scopes installation-wide: it is not the installation-level grant.
    expect(monitorScopeDiagnosticsAllowed(policy(rule({ scopes: ['s'] })), person)).toBe(false);
    expect(monitorScopeDiagnosticsAllowed(policy(rule({ resource: { kind: 'monitor', ids: ['current'] } })), person)).toBe(false);
    expect(monitorScopeDiagnosticsAllowed(policy(rule(), rule({ id: 'no', effect: 'deny', scopes: ['q'] })), person)).toBe(false);
    expect(monitorScopeDiagnosticsAllowed(policy(rule({ effect: 'require-approval' })), person)).toBe(false);
  });
  it('negative: an unreadable policy is a typed failure, never an allow', () => {
    expect(() => monitorScopeDiagnosticsAllowed({ schemaVersion: 99 }, person)).toThrow(expect.objectContaining({ code: 'POLICY_UNAVAILABLE' }));
  });
});
