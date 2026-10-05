import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { resolveProductPaths } from '#platform/index.js';
import { main, runKernelCommand } from '#surfaces/core/cli/index.js';
import { describeDiagnostic } from '#surfaces/core/monitor/internal/diagnostics.js';
import { MonitorApplication } from '#engine/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const stdout = (lines: string[]) => ({ write: (text: string) => { lines.push(text); return true; } });

it('WORKER-AUTO-REFRESH monitor: updating and current are notes, a failed refresh is a problem; all three read in EN and TR', () => {
  expect(describeDiagnostic('info:image-updating', 'en')).toMatchObject({ note: true, text: expect.stringContaining('updated in the background') });
  expect(describeDiagnostic('info:image-updating', 'tr')).toMatchObject({ note: true, text: expect.stringContaining('arka planda') });
  expect(describeDiagnostic('info:image-current:r5-20261006', 'en')).toMatchObject({ note: true, text: expect.stringContaining('r5-20261006') });
  expect(describeDiagnostic('image-refresh-failed:WORKER_IMAGE_BUILD_FAILED', 'en')).toMatchObject({ note: false, text: expect.stringContaining('WORKER_IMAGE_BUILD_FAILED') });
  expect(describeDiagnostic('image-refresh-failed:WORKER_IMAGE_BUILD_FAILED', 'tr')).toMatchObject({ note: false, text: expect.stringContaining('önceki imaj') });
});

it('the monitor snapshot carries the refresh as typed diagnostics, nothing for unknown, and a failing reader never fails the snapshot', async () => {
  const target = { id: 'current', path: '/fixture/project' };
  const snapshot = async (readImageRefresh?: () => Promise<{ status: 'updating' | 'current' | 'failed' | 'unknown'; reason: string | null; imageVersion: string | null }>) => {
    const app = new MonitorApplication({ now: () => 1, readLedger: async () => { throw Object.assign(new Error('x'), { code: 'LEDGER_ABSENT' }); },
      describeService: async () => { throw Object.assign(new Error('x'), { code: 'LOCAL_RUNTIME_UNAVAILABLE' }); }, observeScope: async () => { throw new Error('unused'); },
      ...(readImageRefresh ? { readImageRefresh } : {}) } as never);
    return (await app.inspect([target])).installs[0]!.diagnostics;
  };
  expect(await snapshot(async () => ({ status: 'updating', reason: null, imageVersion: null }))).toContain('info:image-updating');
  expect(await snapshot(async () => ({ status: 'current', reason: null, imageVersion: 'r5-20261006' }))).toContain('info:image-current:r5-20261006');
  expect(await snapshot(async () => ({ status: 'failed', reason: 'REFRESH_EXPIRED', imageVersion: null }))).toContain('image-refresh-failed:REFRESH_EXPIRED');
  expect((await snapshot(async () => ({ status: 'unknown', reason: null, imageVersion: null }))).filter(code => code.includes('image'))).toEqual([]);
  expect((await snapshot()).filter(code => code.includes('image'))).toEqual([]);
  expect(await snapshot(async () => { throw Object.assign(new Error('x'), { code: 'EIO' }); })).toContain('image-refresh-unreadable:EIO');
});

it.each([['updating', 'en', 'being updated in the background'], ['failed', 'tr', 'önceki imaj kullanılıyor'], ['current', 'en', 'current (r5-20261006)']] as const)('doctor shows the image refresh line (%s, %s) and keeps unknown silent', async (status, locale, text) => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-doctor-refresh-')); roots.push(root); const env = { HOME: join(root, '..', 'home'), USERPROFILE: join(root, '..', 'home') };
  const lines: string[] = [];
  await runKernelCommand(['doctor', '--lang', locale], { root, env, stdout: stdout(lines), inspectToolchainRefresh: async () => ({ status, reason: 'WORKER_IMAGE_BUILD_FAILED', imageVersion: 'r5-20261006' }) });
  expect(lines.join('')).toContain(text);
  lines.length = 0;
  await runKernelCommand(['doctor', '--json'], { root, env, stdout: stdout(lines), inspectToolchainRefresh: async () => ({ status, reason: null, imageVersion: null }) });
  expect(JSON.parse(lines.join(''))).toMatchObject({ imageRefresh: { status } });
  lines.length = 0;
  await runKernelCommand(['doctor', '--lang', 'en'], { root, env, stdout: stdout(lines), inspectToolchainRefresh: async () => ({ status: 'unknown', reason: null, imageVersion: null }) });
  expect(lines.join('')).not.toContain('Worker image');
  lines.length = 0;
  await runKernelCommand(['doctor', '--json'], { root, env, stdout: stdout(lines), inspectToolchainRefresh: async () => { throw new Error('unreadable'); } });
  expect(JSON.parse(lines.join(''))).toMatchObject({ imageRefresh: null }); // a failing read never fails doctor
});

it.each([['started', 'en', 'started in the background'], ['failed', 'tr', 'başarısız (WORKER_IMAGE_BUILD_FAILED)'], ['current', 'en', 'updated to r5-20261006'], ['unverified', 'en', 'could not be verified (NPM_REGISTRY_UNAVAILABLE)']] as const)('runtime serve prints the typed refresh event after ready (%s, %s)', async (phase, locale, text) => {
  const controller = new AbortController(); controller.abort(); const out: string[] = [], errs: string[] = [];
  const code = await main(['runtime', 'serve', '--lang', locale], { root: '/fixture/project', env: { HOME: '/fixture/home' }, signal: controller.signal, stdout: stdout(out), stderr: stdout(errs),
    async startRuntimeService(_root, observer) {
      setTimeout(() => void observer.onToolchainRefresh?.({ phase, imageVersion: 'r5-20261006', imageId: phase === 'current' ? 'sha256:' + 'b'.repeat(64) : null, appliedProfiles: 1,
        code: phase === 'failed' ? 'WORKER_IMAGE_BUILD_FAILED' : phase === 'unverified' ? 'NPM_REGISTRY_UNAVAILABLE' : null }), 5); // after ready, like the real background refresh
      return { endpoint: '/runtime.sock', layout: resolveProductPaths('/fixture/project', { env: { HOME: '/fixture/home' } }), done: new Promise<void>(resolve => setTimeout(resolve, 60)),
        async stop() { return { state: 'clean', remainingRequests: 0, recoveryPending: false } as const; } };
    } });
  expect(code).toBe(0);
  expect([...out, ...errs].join('')).toContain(text);
});
