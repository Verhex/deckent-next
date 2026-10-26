import { describe, expect, it, vi } from 'vitest';
import { MonitorApplication, type MonitorPorts } from '#engine/index.js';
import type { BrainQuotaWaitRecord } from '#domain/index.js';
import { loadMonitorSurface } from '#surfaces/core/monitor/index.js';
import type { MonitorSnapshot } from '#engine/index.js';

// f4 item 1 (no-MVP gap of owner Q-H4): an active Brain quota wait is shown by the standalone monitor and MCP `inspect_monitor` (the same
// snapshot) before any Run exists — only in scopes the viewer may read, with the same scope decision as Runs. Fake ports; no model call.
const NOW = 1_800_000_000_000;
const failure = (code: string) => Object.assign(new Error(code), { code });
const wait = (scopeId: string, commandId: string, sinceMs = NOW - 1_000): BrainQuotaWaitRecord => ({ schemaVersion: 1, scopeId, commandId, attempt: 2, maxAttempts: 2,
  sinceMs, resetsAtMs: NOW + 60_000, untilMs: NOW + 75_000, after: { commandId: 'a'.repeat(64), invocationId: 'inv-1' } });
const ledger = { ledgerVersion: 44, scopeIds: ['s'], diagnostics: [], approvals: [], runs: [], pools: [] };
function app(readBrainWaits?: MonitorPorts['readBrainWaits'], observed: string[] = []) {
  return new MonitorApplication({ now: () => NOW, describeService: async () => { throw failure('LOCAL_RUNTIME_UNAVAILABLE'); }, observePool: async () => true,
    indexLedger: async () => ({ ledgerVersion: 44, scopeIds: ['s'], poolIds: [] }), readLedger: async () => ledger,
    async observeScope(_target, scopeId) {
      observed.push(scopeId);
      if (scopeId === 'locked') throw failure('LEDGER_LOCKED');
      if (scopeId === 'other') return { access: 'denied', reason: 'POLICY_DENIED', workers: [], workerStatus: 'denied', truncated: false };
      return { access: 'admitted', workers: [], workerStatus: 'available', truncated: false };
    }, ...(readBrainWaits ? { readBrainWaits } : {}) });
}
type MonitorTextOptions = Parameters<Awaited<ReturnType<typeof loadMonitorSurface>>['renderMonitorText']>[1];
const renderMonitorText = async (snapshot: MonitorSnapshot, options: MonitorTextOptions) => (await loadMonitorSurface()).renderMonitorText(snapshot, options);
const inspect = async (monitor: MonitorApplication) => (await monitor.inspect([{ id: 'current', path: '/c' }])).installs[0]!;

describe('f4 monitor: Brain quota waits before a Run exists', () => {
  it('shows a wait of a readable scope, also one the ledger does not name yet (no Run), asking that scope the same decision as Runs', async () => {
    const observed: string[] = [], install = await inspect(app(async () => ({ records: [wait('s', 'plan-a'), wait('fresh', 'plan-b')], truncated: false }), observed));
    expect(install.brainWaits?.map(entry => [entry.scopeId, entry.commandId])).toEqual([['s', 'plan-a'], ['fresh', 'plan-b']]);
    expect(install.runs).toEqual([]); expect(install.status).toBe('available'); expect(install.scopeIds).toEqual(['s']);
    expect(observed).toEqual(['s', 'fresh']); expect(install.diagnostics).toEqual([]);
  });
  it('negative: a wait in a scope the viewer may not read (denied or failed decision) is never shown or named; only a count', async () => {
    const install = await inspect(app(async () => ({ records: [wait('s', 'plan-a'), wait('other', 'plan-secret'), wait('locked', 'plan-locked')], truncated: true })));
    expect(install.brainWaits?.map(entry => entry.commandId)).toEqual(['plan-a']);
    expect(install.diagnostics).toEqual(['info:brain-waits-hidden:2', 'info:brain-waits-truncated']);
    expect(JSON.stringify(install)).not.toMatch(/plan-secret|plan-locked|"other"|"locked"/);
    // A hidden wait never turns the install into a denied one.
    expect(install.status).toBe('available');
  });
  it('negative: no wait, no port or a failed read adds no field; a failed read is a problem code, never an exception', async () => {
    expect(await inspect(app(async () => ({ records: [], truncated: false })))).not.toHaveProperty('brainWaits');
    expect(await inspect(app())).not.toHaveProperty('brainWaits');
    const failed = await inspect(app(async () => { throw failure('MANAGED_FILE_UNSAFE'); }));
    expect(failed).not.toHaveProperty('brainWaits'); expect(failed.diagnostics).toEqual(['brain-waits-unavailable:MANAGED_FILE_UNSAFE']);
  });
  it('the monitor text (deckent monitor --once, /monitor) names the wait in EN and TR: scope, plan, reset time and attempt, no Run yet', async () => {
    const snapshot = await app(vi.fn(async () => ({ records: [wait('s', 'plan-a')], truncated: false }))).inspect([{ id: 'current', path: '/c' }]);
    const en = await renderMonitorText(snapshot, { locale: 'en', width: 200, ascii: true }), tr = await renderMonitorText(snapshot, { locale: 'tr', width: 200, ascii: true });
    expect(en).toContain('Brain waiting for the subscription quota (1) — no Run exists yet');
    expect(en).toMatch(/s · plan plan-a · plans again at .+ \(attempt 2 of 2\) · waiting since /u);
    expect(tr).toContain('Abonelik kotasını bekleyen Brain (1) — henüz iş yok');
    expect(tr).toMatch(/s · plan plan-a · .+ saatinde yeniden planlar \(deneme 2\/2\)/u);
    const none = await app(async () => ({ records: [], truncated: false })).inspect([{ id: 'current', path: '/c' }]);
    expect(await renderMonitorText(none, { locale: 'en', width: 200, ascii: true })).not.toContain('Brain waiting');
  });
  it('diagnostic words: hidden count, truncation and an unreadable store in EN and TR', async () => {
    const snapshot = await app(async () => ({ records: [wait('other', 'x')], truncated: true })).inspect([{ id: 'current', path: '/c' }]);
    expect(await renderMonitorText(snapshot, { locale: 'en', width: 200, ascii: true })).toContain('1 Brain quota wait(s) in scopes you may not read are not shown');
    expect(await renderMonitorText(snapshot, { locale: 'tr', width: 200, ascii: true })).toContain("Okuyamadığınız kapsamlardaki 1 Brain kota beklemesi gösterilmiyor");
    const failed = await app(async () => { throw failure('MANAGED_FILE_UNSAFE'); }).inspect([{ id: 'current', path: '/c' }]);
    expect(await renderMonitorText(failed, { locale: 'en', width: 200, ascii: true })).toContain('Brain quota waits could not be read (MANAGED_FILE_UNSAFE)');
  });
});
