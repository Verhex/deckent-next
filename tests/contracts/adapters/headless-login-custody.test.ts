import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { headlessLoginLockPath, nativeCliHeadless, withHeadlessLoginLock } from '#adapters/core/native-cli-headless/index.js';
import { DeckentError } from '#platform/index.js';
import { FAMILY } from '../../fixtures/native-headless/stream.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-login-custody-')); roots.push(root);
  const configDir = join(root, 'login'), stateDir = join(root, 'connection'), locks = join(root, 'login-locks');
  await mkdir(configDir, { mode: 0o700 }); await mkdir(locks, { mode: 0o700 });
  const base = nativeCliHeadless(FAMILY)!;
  const entry = { ...base, headless: { ...base.headless, isolation: { ...base.headless.isolation, refreshLock: { ...base.headless.isolation.refreshLock, waitMs: 30, pollMs: 2 } } } };
  return { configDir, stateDir, entry, marker: headlessLoginLockPath(configDir, stateDir) };
}
it.skipIf(process.platform !== 'linux')('does not reclaim an old live holder and never runs its callback', async () => {
  const f = await fixture(); await writeFile(f.marker, JSON.stringify({ pid: process.pid, atMs: 0, token: 'legacy' }), { mode: 0o600 });
  let ran = false;
  await expect(withHeadlessLoginLock(f.entry, f.configDir, f.stateDir, () => 999_999, async () => { ran = true; })).rejects.toMatchObject({ code: 'HEADLESS_LOGIN_BUSY', params: { holder: 'legacy-process' } });
  expect(ran).toBe(false); expect(JSON.parse(await readFile(f.marker, 'utf8')).token).toBe('legacy');
});
it.skipIf(process.platform !== 'linux')('holds the same kernel inode through a long approval wait, releases on cancellation, and never overlaps contenders', async () => {
  const f = await fixture(); let release!: () => void, entered!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const running = withHeadlessLoginLock(f.entry, f.configDir, f.stateDir, () => 0, async () => { entered(); await barrier; throw new Error('cancelled'); });
  await started; let calls = 0;
  try {
    const waiter = withHeadlessLoginLock(f.entry, f.configDir, f.stateDir, () => 999_999, async () => { calls++; });
    await expect(waiter).rejects.toMatchObject({ code: 'HEADLESS_LOGIN_BUSY', params: { holder: 'guard' } });
    const fault = await waiter.catch((error: DeckentError) => error);
    if (!(fault instanceof DeckentError)) throw new Error('The second waiter did not return its diagnostic');
    expect.soft(fault.localize?.('en').message).toBe('The sign-in lock guard remained held at the end of the wait. Wait for the other operation to finish, then try again.');
    expect.soft(fault.localize?.('tr').message).toBe('Bekleme sonunda giriş kilidi koruması hâlâ tutuluyordu. Diğer işlem bitince yeniden deneyin.');
  } finally { release(); }
  await expect(running).rejects.toThrow('cancelled'); expect(calls).toBe(0);
  await withHeadlessLoginLock(f.entry, f.configDir, f.stateDir, () => 999_999, async () => { calls++; }); expect(calls).toBe(1);
});
it.skipIf(process.platform !== 'linux')('keeps malformed legacy custody closed rather than treating parse failure as release proof', async () => {
  const f = await fixture(); await writeFile(f.marker, '{broken', { mode: 0o600 });
  const refusal = () => withHeadlessLoginLock(f.entry, f.configDir, f.stateDir, () => 0, async () => { throw new Error('must not run'); });
  const invalidMarker = refusal();
  await expect(invalidMarker).rejects.toMatchObject({ code: 'HEADLESS_LOGIN_BUSY' });
  expect(await readFile(f.marker, 'utf8')).toBe('{broken');
  const malformed = await invalidMarker.catch((error: unknown) => error);
  expect(malformed).toBeInstanceOf(DeckentError);
  const unreadable = malformed as DeckentError;
  expect.soft(unreadable.localize?.('en').message).toContain('no verifiable holder');
  expect.soft(unreadable.localize?.('tr').message).toContain('sahibi hâlâ doğrulanamamıştı');
  expect.soft(unreadable.localize?.('en').message).not.toContain('Another subscription Brain call');
  expect.soft(unreadable.localize?.('tr').message).not.toContain('başka bir abonelik Brain çağrısı');

  await writeFile(f.marker, JSON.stringify({ pid: process.pid, atMs: 0, token: 'live' }));
  const live = await refusal().catch((error: unknown) => error);
  expect(live).toBeInstanceOf(DeckentError);
  const observed = live as DeckentError;
  expect.soft(observed.localize?.('en').message).toContain('process ID in the sign-in lock marker still existed');
  expect.soft(observed.localize?.('tr').message).toContain('kimliğe sahip bir süreç hâlâ vardı');
  expect(JSON.parse(await readFile(f.marker, 'utf8')).token).toBe('live');
});

it.skipIf(process.platform !== 'linux')('releases kernel custody after the holder process crashes, preserving the same companion inode', async () => {
  const f = await fixture(), modulePath = resolve('src/adapters/core/local-runtime-socket/native/build/Release/peer_credentials.node');
  const child = spawn(process.execPath, ['-e', 'require(process.argv[1]).lockFile(process.argv[2]); require("node:fs").writeFileSync(process.argv[3], JSON.stringify({schemaVersion:2,pid:process.pid,atMs:0,token:"crashed"}), {mode:0o600}); process.send("held"); setInterval(() => {}, 1000);', modulePath, f.marker + '.guard', f.marker],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: {} });
  let calls = 0;
  try {
    await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error('lock holder exited before ready'); })]);
    await expect(withHeadlessLoginLock(f.entry, f.configDir, f.stateDir, () => 0, async () => { calls++; })).rejects.toMatchObject({ code: 'HEADLESS_LOGIN_BUSY' });
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    await withHeadlessLoginLock(f.entry, f.configDir, f.stateDir, () => 1, async () => { calls++; });
    expect(calls).toBe(1);
  } finally { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; } }
});

it.skipIf(process.platform !== 'linux')('refuses a linked marker before following it or running the callback', async () => {
  const f = await fixture(), target = f.marker + '.sentinel'; await writeFile(target, 'private-fixture', { mode: 0o600 }); await symlink(target, f.marker);
  await expect(withHeadlessLoginLock(f.entry, f.configDir, f.stateDir, () => 0, async () => { throw new Error('must not run'); })).rejects.toMatchObject({ code: 'HEADLESS_PREFLIGHT_FAILED' });
  expect(await readFile(target, 'utf8')).toBe('private-fixture');
});
