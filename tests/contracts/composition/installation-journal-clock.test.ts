import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { applyPolicyTemplateInstallation } from '#composition/core/installation/index.js';
import * as adapters from '#adapters/index.js';
import * as platform from '#platform/index.js';

// SECRET-WRITE-CLOCK (proof/SECRET-WRITE-FLAKE-2026-10-01): the composed `deckent init policy --apply` path over the real on-disk
// journal while the host wall clock steps backwards. Before the fix the writer refused its own record (TIME_ORDER ->
// INSTALLATION_JOURNAL_INVALID at the journal store) and left the installation pending. Own file: the trusted clock's process
// floor and the SystemTrustedClock mock must not leak into other suites.
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function project() { const root = await mkdtemp(join(tmpdir(), 'deckent-journal-clock-')); roots.push(root); return root; }
const journalPath = (root: string) => platform.productResourcePath(platform.resolveProductLayout({ projectRoot: root }), 'installationJournal');
const RealClock = platform.SystemTrustedClock;
/** Each construction is what a separate process gets: a fresh wall floor over the given raw source. */
function clockPerOperation(source: () => number) {
  let samples = 0;
  vi.spyOn(platform, 'SystemTrustedClock').mockImplementation(function () {
    const clock = new RealClock(source);
    return { sample: () => { samples++; return clock.sample(); } };
  } as never);
  return { get samples() { return samples; } };
}

it('the flake: Date.now stepping back 1 s right after the pending entry still installs and commits on the first attempt', async () => {
  const root = await project(), base = Date.now(), raw = Date.now.bind(Date);
  // Ordering-independent: the step happens exactly once the pending journal exists on disk (the measured flake window).
  vi.spyOn(Date, 'now').mockImplementation(() => existsSync(journalPath(root)) ? base - 1000 : Math.max(base, raw()));
  await expect(applyPolicyTemplateInstallation(root, 'installation')).resolves.toMatchObject({ status: 'installed' });
  vi.restoreAllMocks();
  const { record } = await platform.observeBootstrapState(root);
  expect(record).toMatchObject({ phase: 'committed', blockers: [] });
  expect(record!.updatedAtMs).toBeGreaterThanOrEqual(record!.createdAtMs);
});

it('a retry in a new process whose wall clock is behind the persisted createdAtMs completes the pending installation', async () => {
  const root = await project(), ahead = Date.now() + 60_000;
  // First attempt: a clock 60 s ahead (e.g. before an NTP correction); it dies after the policy file is published.
  clockPerOperation(() => ahead); const raw = Date.now.bind(Date); vi.spyOn(Date, 'now').mockImplementation(() => ahead);
  const publish = adapters.publishInstallationFile;
  let published = 0;
  vi.spyOn(adapters, 'publishInstallationFile').mockImplementation(async (...args) => {
    if (++published === 2) throw new Error('CRASH_BEFORE_SECOND_TARGET'); return publish(...args);
  });
  await expect(applyPolicyTemplateInstallation(root, 'installation')).rejects.toThrow('CRASH_BEFORE_SECOND_TARGET');
  vi.restoreAllMocks();
  const pending = (await platform.observeBootstrapState(root)).record;
  expect(pending).toMatchObject({ phase: 'pending', createdAtMs: ahead });
  // Retry: a new process (fresh floor) on the corrected, now earlier, wall clock.
  expect(raw()).toBeLessThan(ahead);
  clockPerOperation(() => Date.now());
  await expect(applyPolicyTemplateInstallation(root, 'installation')).resolves.toMatchObject({ status: 'installed' });
  expect((await platform.observeBootstrapState(root)).record).toMatchObject({ phase: 'committed', createdAtMs: ahead, updatedAtMs: ahead });
});

it('reads journal time from the platform trusted clock (I40), not raw Date.now', async () => {
  const root = await project(), trusted = 1_000_000_000_000; // far from the real wall time, so a raw Date.now read is visible
  const clock = clockPerOperation(() => trusted);
  await expect(applyPolicyTemplateInstallation(root, 'installation')).resolves.toMatchObject({ status: 'installed' });
  expect(clock.samples).toBe(4); // pending, two published updates, commit
  expect((await platform.observeBootstrapState(root)).record).toMatchObject({ phase: 'committed', createdAtMs: trusted, updatedAtMs: trusted });
});
