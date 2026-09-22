import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { assessToolchain, buildToolchainCurrencyReport, insertHistoryLine, nextImageVersion, planToolchainUpdate, proposeProfileRevisions } from '#engine/index.js';

const recipe = { schemaVersion: 2, repository: 'deckent/worker', imageVersion: 'r2-20260922', previousVersion: 'r1-20260921', baseImage: 'node:24-trixie-slim', npmProviders: [], cursor: {} };
const published = (version: string) => ({ kind: 'published' as const, published: { version, source: 'fixture', observedAt: '2026-09-23T08:00:00.000Z' } });
const admitted = (provider: string, cliVersion: string, id: string) => ({ profile: { id, version: 1 }, provider, cliVersion });
const report = (codexLatest: string) => buildToolchainCurrencyReport({ measuredAt: '2026-09-23T08:00:00.000Z', mode: 'report', registryEndpoint: 'https://registry.example.invalid', entries: [
  assessToolchain('codex', [admitted('codex', 'codex-cli 0.155.1', 'codex-a')], published(codexLatest)),
  assessToolchain('claude', [admitted('claude', '2.1.278 (Claude Code)', 'claude-a')], published('2.1.278')),
  assessToolchain('cursor', [], { kind: 'unsupported' })] });
const affected = [{ profile: { id: 'codex-a', version: 1 }, provider: 'codex', cliVersion: 'codex-cli 0.155.1', imageId: 'sha256:' + 'a'.repeat(64) },
  { profile: { id: 'claude-a', version: 1 }, provider: 'claude', cliVersion: '2.1.278 (Claude Code)', imageId: null }];

it('advances the version counter with the planning day and inserts the newest history line ahead of the recorded ones', async () => {
  expect(nextImageVersion('r2-20260922', '2026-09-23T08:00:00.000Z')).toBe('r3-20260923');
  expect(nextImageVersion('r10-20260101', '2026-09-23T08:00:00.000Z')).toBe('r11-20260923');
  expect(() => nextImageVersion('v2', '2026-09-23T08:00:00.000Z')).toThrow('TOOLCHAIN_RECIPE_INVALID');
  const dockerfile = await readFile(new URL('../../../assets/worker-image/Dockerfile', import.meta.url), 'utf8');
  const edited = insertHistoryLine(dockerfile, '# version r3-20260923 | 2026-09-23 | base node:24-trixie-slim | supersedes r2-20260922 | test');
  const lines = edited.split('\n').filter(line => /^# version r/.test(line));
  expect(lines[0]).toMatch(/^# version r3-20260923/); expect(lines[1]).toMatch(/^# version r2-20260922/);
  expect(() => insertHistoryLine('FROM x\n', '# version r3-20260923 | ...')).toThrow('TOOLCHAIN_HISTORY_INVALID');
});
it('plans no change when nothing is stale and a single next version when an npm provider is stale', () => {
  const fresh = planToolchainUpdate({ report: report('0.155.1'), recipe, plannedAt: '2026-09-23T08:00:00.000Z', affectedProfiles: affected });
  expect(fresh).toMatchObject({ decision: 'no-change', staleProviders: [], next: null, affectedProfiles: [] });
  const stale = planToolchainUpdate({ report: report('0.156.0'), recipe, plannedAt: '2026-09-23T08:00:00.000Z', affectedProfiles: affected });
  expect(stale).toMatchObject({ decision: 'build', staleProviders: ['codex'], current: { imageVersion: 'r2-20260922' },
    next: { imageVersion: 'r3-20260923', previousVersion: 'r2-20260922', recipe: { imageVersion: 'r3-20260923', previousVersion: 'r2-20260922', repository: 'deckent/worker' } } });
  expect(stale.next!.historyLine).toBe('# version r3-20260923 | 2026-09-23 | base node:24-trixie-slim | supersedes r2-20260922 | toolchain currency: codex 0.155.1 -> 0.156.0');
  // Only profiles of stale providers are affected; the fresh Claude profile is not touched.
  expect(stale.affectedProfiles.map(item => item.profile.id)).toEqual(['codex-a']);
  expect(() => planToolchainUpdate({ report: report('0.156.0'), recipe: { ...recipe, imageVersion: 'latest' }, plannedAt: '2026-09-23T08:00:00.000Z', affectedProfiles: [] })).toThrow('TOOLCHAIN_RECIPE_INVALID');
});
it('derives exact profile changes from a build receipt and refuses mismatched or incomplete receipts', () => {
  const plan = planToolchainUpdate({ report: report('0.156.0'), recipe, plannedAt: '2026-09-23T08:00:00.000Z', affectedProfiles: affected });
  const receipt = { schemaVersion: 2, imageId: 'sha256:' + 'b'.repeat(64), imageVersion: 'r3-20260923', tag: 'deckent/worker:r3-20260923',
    manifest: { providers: [{ id: 'codex', version: 'codex-cli 0.156.0' }, { id: 'claude', version: '2.1.278 (Claude Code)' }, { id: 'cursor', version: '2026.09.18-9a7762b' }] } };
  const proposal = proposeProfileRevisions(plan, receipt, '2026-09-23T08:30:00.000Z');
  expect(proposal).toMatchObject({ imageVersion: 'r3-20260923', tag: 'deckent/worker:r3-20260923', application: 'not-applied',
    profiles: [{ profile: { id: 'codex-a', version: 1 }, provider: 'codex', changes: { cliVersion: { from: 'codex-cli 0.155.1', to: 'codex-cli 0.156.0' }, imageId: { from: 'sha256:' + 'a'.repeat(64), to: 'sha256:' + 'b'.repeat(64) } } }] });
  expect(() => proposeProfileRevisions(plan, { ...receipt, imageVersion: 'r4-20260923' }, '2026-09-23T08:30:00.000Z')).toThrow('TOOLCHAIN_RECEIPT_INVALID');
  expect(() => proposeProfileRevisions(plan, { ...receipt, manifest: { providers: [] } }, '2026-09-23T08:30:00.000Z')).toThrow('TOOLCHAIN_RECEIPT_INVALID');
  const noChange = planToolchainUpdate({ report: report('0.155.1'), recipe, plannedAt: '2026-09-23T08:00:00.000Z', affectedProfiles: affected });
  expect(() => proposeProfileRevisions(noChange, receipt, '2026-09-23T08:30:00.000Z')).toThrow('TOOLCHAIN_RECEIPT_INVALID');
});
