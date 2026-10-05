import { describe, expect, it } from 'vitest';
import { refreshInProgress, refreshIntervalMs, refreshStatus, refreshTriggerAllowed, reviseRegistryForProposal, toolchainUpdateApplies,
  toolchainRefreshStateSchema, unverifiedReason, type ToolchainCurrencyReport } from '#engine/index.js';

const sha = (c: string) => 'sha256:' + c.repeat(64);
const state = (patch: Record<string, unknown> = {}) => toolchainRefreshStateSchema.parse({ schemaVersion: 1, phase: 'updating', trigger: 'startup', startedAt: '2026-10-06T10:00:00.000Z', finishedAt: null,
  expiresAt: '2026-10-06T11:00:00.000Z', imageVersion: 'r5-20261006', imageId: null, staleProviders: ['codex'], appliedProfiles: 0, reason: null, ...patch });
const T = (iso: string) => Date.parse(iso);

describe('refresh policy', () => {
  it('builds only in auto mode; start needs atStartup, interval needs a positive intervalMs', () => {
    for (const mode of ['off', 'propose'] as const) for (const trigger of ['startup', 'interval'] as const) expect(refreshTriggerAllowed({ mode, atStartup: true, intervalMs: 1000 }, trigger)).toBe(false);
    expect(refreshTriggerAllowed({ mode: 'auto', atStartup: true, intervalMs: 0 }, 'startup')).toBe(true);
    expect(refreshTriggerAllowed({ mode: 'auto', atStartup: false, intervalMs: 5 }, 'startup')).toBe(false);
    expect(refreshTriggerAllowed({ mode: 'auto', atStartup: true, intervalMs: 0 }, 'interval')).toBe(false);
    expect(refreshTriggerAllowed({ mode: 'auto', atStartup: false, intervalMs: 5 }, 'interval')).toBe(true);
    expect(refreshIntervalMs({ mode: 'auto', atStartup: true, intervalMs: 7 })).toBe(7); expect(refreshIntervalMs({ mode: 'propose', atStartup: true, intervalMs: 7 })).toBe(0);
    expect(toolchainUpdateApplies('auto')).toBe(true); expect(toolchainUpdateApplies('propose')).toBe(false); expect(toolchainUpdateApplies('propose', true)).toBe(true); expect(toolchainUpdateApplies('off')).toBe(false);
  });
  it('an updating marker counts as in flight only inside its bound; other phases and no marker never do', () => {
    expect(refreshInProgress(state(), T('2026-10-06T10:30:00.000Z'))).toBe(true);
    expect(refreshInProgress(state(), T('2026-10-06T11:00:00.001Z'))).toBe(false);
    expect(refreshInProgress(null, 0)).toBe(false);
    for (const phase of ['current', 'failed', 'unverified']) expect(refreshInProgress(state({ phase, finishedAt: '2026-10-06T10:10:00.000Z' }), T('2026-10-06T10:30:00.000Z'))).toBe(false);
  });
  it('status words: updating, current, failed with its reason, an expired marker as failed, unverified as unknown, none as unknown', () => {
    const now = T('2026-10-06T10:30:00.000Z');
    expect(refreshStatus(state(), now)).toEqual({ status: 'updating', reason: null });
    expect(refreshStatus(state({ phase: 'current', finishedAt: '2026-10-06T10:10:00.000Z' }), now)).toEqual({ status: 'current', reason: null });
    expect(refreshStatus(state({ phase: 'failed', finishedAt: '2026-10-06T10:10:00.000Z', reason: 'WORKER_IMAGE_BUILD_FAILED' }), now)).toEqual({ status: 'failed', reason: 'WORKER_IMAGE_BUILD_FAILED' });
    expect(refreshStatus(state(), T('2026-10-06T12:00:00.000Z'))).toEqual({ status: 'failed', reason: 'REFRESH_EXPIRED' });
    expect(refreshStatus(state({ phase: 'unverified', finishedAt: '2026-10-06T10:10:00.000Z', reason: 'NPM_REGISTRY_UNAVAILABLE' }), now)).toEqual({ status: 'unknown', reason: 'NPM_REGISTRY_UNAVAILABLE' });
    expect(refreshStatus(null, now)).toEqual({ status: 'unknown', reason: null });
    expect(toolchainRefreshStateSchema.safeParse({ ...state(), phase: 'building' }).success).toBe(false);
  });
  it('currency is unverified when an admitted provider could not be compared, never silently current', () => {
    const entry = (status: string, admitted: number, reason?: string) => ({ provider: 'p', admitted: Array.from({ length: admitted }, () => ({})), status, ...(reason ? { reason } : {}) });
    const report = (...entries: ReturnType<typeof entry>[]) => ({ providers: entries }) as unknown as ToolchainCurrencyReport;
    expect(unverifiedReason(report(entry('fresh', 1), entry('unknown-offline', 0)))).toBeNull(); // not admitted: irrelevant
    expect(unverifiedReason(report(entry('unknown-offline', 1, 'NPM_REGISTRY_UNAVAILABLE')))).toBe('NPM_REGISTRY_UNAVAILABLE');
    expect(unverifiedReason(report(entry('unparsed', 1)))).toBe('CURRENCY_UNPARSED');
    expect(unverifiedReason(report(entry('disabled', 1)))).toBe('CURRENCY_DISABLED');
  });
});

describe('registry revision of a built image', () => {
  const native = (id: string, version: number, image: string, cli: string) => ({ id, version, adapter: { id: 'docker', version: 2 }, parameters: { imageId: image, argv: ['x'],
    nativeSubscription: { provider: 'p', preflight: { cliVersion: cli } } } });
  const template = (id: string, version: number, image: string, cli: string) => ({ id, version, adapter: { id: 'native-coding-template', version: 1 },
    parameters: { docker: { imageId: image }, invocation: { provider: 'p', cliVersion: cli } } });
  const registry = (profiles: unknown[], kinds: [string, string, number][]) => ({ schemaVersion: 1, revision: 'rev', profiles, kinds: kinds.map(([kind, id, version]) => ({ kind, profile: { id, version } })),
    evaluators: [{ id: 'e', version: 1, implementation: { id: 'e', version: 1 } }] });
  const proposal = (...ids: [string, number][]) => ({ schemaVersion: 1, kind: 'profile-revision-proposal', proposedAt: '2026-10-06T10:00:00.000Z', imageVersion: 'r5-20261006', imageId: sha('b'), tag: null, application: 'not-applied', basis: 'x',
    profiles: ids.map(([id, version]) => ({ profile: { id, version }, provider: 'p', changes: { cliVersion: { from: 'old', to: 'new' }, imageId: { from: sha('a'), to: sha('b') } } })) }) as never;
  it('adds a new version with the new image and CLI pin, repoints only its kinds, keeps the old version, bumps the revision', () => {
    const input = registry([native('n', 1, sha('a'), 'old'), template('t', 1, sha('a'), 'old'), native('other', 1, sha('a'), 'old')], [['kn', 'n', 1], ['kt', 't', 1], ['ko', 'other', 1]]);
    const revised = reviseRegistryForProposal(input, proposal(['n', 1], ['t', 1]))!;
    expect(revised.applied).toEqual([{ profile: 'n', from: 1, to: 2 }, { profile: 't', from: 1, to: 2 }]);
    const byKey = (id: string, version: number) => revised.registry.profiles.find(profile => profile.id === id && profile.version === version) as unknown as { parameters: Record<string, never> };
    expect(byKey('n', 1).parameters).toMatchObject({ imageId: sha('a') });
    expect(byKey('n', 2).parameters).toMatchObject({ imageId: sha('b'), nativeSubscription: { preflight: { cliVersion: 'new' } } });
    expect(byKey('t', 2).parameters).toMatchObject({ docker: { imageId: sha('b') }, invocation: { cliVersion: 'new' } });
    expect(byKey('other', 1).parameters).toMatchObject({ imageId: sha('a') });
    expect(revised.registry.kinds.map(kind => `${kind.kind}:${kind.profile.version}`)).toEqual(['kn:2', 'kt:2', 'ko:1']);
    expect(revised.registry.revision).toBe('rev@r5-20261006');
    expect((input.profiles[0] as { version: number }).version).toBe(1); // the input is never mutated
  });
  it('is idempotent: a superseded version is never revised again, a repeated proposal changes nothing', () => {
    const once = reviseRegistryForProposal(registry([native('n', 1, sha('a'), 'old')], [['kn', 'n', 1]]), proposal(['n', 1]))!;
    expect(reviseRegistryForProposal(once.registry, proposal(['n', 1]))).toBeNull();
    expect(reviseRegistryForProposal(once.registry, proposal(['n', 2]))).toBeNull(); // already at the proposed image and pin
  });
  it('ignores proposals for unknown or unpointed profiles and refuses an invalid registry', () => {
    expect(reviseRegistryForProposal(registry([native('n', 1, sha('a'), 'old')], [['kn', 'n', 1]]), proposal(['missing', 1]))).toBeNull();
    expect(() => reviseRegistryForProposal({ schemaVersion: 1 }, proposal(['n', 1]))).toThrow();
  });
});
