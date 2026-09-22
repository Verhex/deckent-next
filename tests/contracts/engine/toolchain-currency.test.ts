import { expect, it } from 'vitest';
import { assessToolchain, buildToolchainCurrencyReport, compareToolchainVersions, extractToolchainVersion, toolchainCatalog } from '#engine/index.js';

const admitted = (provider: string, cliVersion: string, id = 'p') => ({ profile: { id, version: 1 }, provider, cliVersion });
const published = (version: string) => ({ kind: 'published' as const, published: { version, source: 'fixture', observedAt: '2026-09-22T10:00:00.000Z' } });

it('extracts comparable versions from provider version output using catalog patterns', () => {
  expect(extractToolchainVersion('codex', 'codex-cli 0.155.1')).toBe('0.155.1');
  expect(extractToolchainVersion('claude', '2.1.278 (Claude Code)')).toBe('2.1.278');
  // Cursor's version is extractable, but its distribution mechanism has no currency source (status stays unsupported).
  expect(extractToolchainVersion('cursor', '2026.09.18-9a7762b')).toBe('2026.09.18-9a7762b');
  expect(extractToolchainVersion('codex', 'claude 2.1.278')).toBe(null);
  expect(() => extractToolchainVersion('unknown-provider', 'x')).toThrow('TOOLCHAIN_PROVIDER_UNKNOWN');
  expect(Object.keys(toolchainCatalog.providers).sort()).toEqual(['claude', 'codex', 'cursor']);
});
it('orders versions numerically with prereleases below their release and build metadata ignored', () => {
  expect(compareToolchainVersions('0.155.1', '0.156.0')).toBe(-1);
  expect(compareToolchainVersions('2.1.278', '2.1.278')).toBe(0);
  expect(compareToolchainVersions('2.1.300', '2.1.278')).toBe(1);
  expect(compareToolchainVersions('1.0.0-beta.2', '1.0.0')).toBe(-1);
  expect(compareToolchainVersions('1.0.0-beta.2', '1.0.0-beta.10')).toBe(-1);
  expect(compareToolchainVersions('1.0.0+build.5', '1.0.0')).toBe(0);
  expect(compareToolchainVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
});
it('assesses each provider from durable admitted pins and a supplied lookup outcome without inventing evidence', () => {
  expect(assessToolchain('codex', [admitted('codex', 'codex-cli 0.155.1')], published('0.155.1'))).toMatchObject({ status: 'fresh', package: '@openai/codex', latest: { version: '0.155.1' }, selfUpdateControl: 'check_for_update_on_startup=false' });
  expect(assessToolchain('codex', [admitted('codex', 'codex-cli 0.155.1'), admitted('codex', 'codex-cli 0.150.0', 'q')], published('0.155.1')).status).toBe('stale');
  expect(assessToolchain('claude', [admitted('claude', '2.1.300 (Claude Code)')], published('2.1.278')).status).toBe('ahead');
  expect(assessToolchain('claude', [admitted('claude', 'weird output')], published('2.1.278'))).toMatchObject({ status: 'unparsed', admitted: [{ version: null }] });
  expect(assessToolchain('claude', [admitted('claude', '2.1.278 (Claude Code)')], { kind: 'unavailable', reason: 'NPM_REGISTRY_TIMEOUT' })).toMatchObject({ status: 'unknown-offline', reason: 'NPM_REGISTRY_TIMEOUT', latest: null });
  expect(assessToolchain('claude', [admitted('claude', '2.1.278 (Claude Code)')], { kind: 'disabled' }).status).toBe('disabled');
  expect(assessToolchain('claude', [], published('2.1.278')).status).toBe('not-admitted');
  expect(assessToolchain('cursor', [admitted('cursor', '2026.09.18-9a7762b')], { kind: 'unsupported' })).toMatchObject({ status: 'unsupported', mechanism: 'installer-script', update: 'agent update' });
  // Foreign-provider pins are ignored, never mixed into another provider's assessment.
  expect(assessToolchain('codex', [admitted('claude', '2.1.278 (Claude Code)')], published('0.155.1')).status).toBe('not-admitted');
});
it('builds a sorted advisory report that records mode and endpoint without claiming any update', () => {
  const report = buildToolchainCurrencyReport({ measuredAt: '2026-09-22T10:00:00.000Z', mode: 'report', registryEndpoint: 'https://registry.example.invalid',
    entries: [assessToolchain('cursor', [], { kind: 'unsupported' }), assessToolchain('codex', [admitted('codex', 'codex-cli 0.155.1')], published('0.155.1'))] });
  expect(report.providers.map(entry => entry.provider)).toEqual(['codex', 'cursor']);
  expect(report.basis).toMatch(/never activates, rebuilds or updates/);
  expect(() => buildToolchainCurrencyReport({ measuredAt: 'not-a-time', mode: 'report', registryEndpoint: null, entries: [] })).toThrow();
});
