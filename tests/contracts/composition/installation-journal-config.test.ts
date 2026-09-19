import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { withInstallationJournal } from '../../../src/adapters/core/installation-journal/index.js';
import { clearConfigCache, loadConfig, observeBootstrapState, productResourcePath,
  resolveProductLayout, type BootstrapJournalPayload } from '../../../src/platform/index.js';

const roots: string[] = [];
const hex = (character: string) => character.repeat(64);
const options = { timeoutMs: 2_000 };
const compiledJournal = resolve('dist/adapters/core/installation-journal/index.js');

afterEach(async () => {
  clearConfigCache();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-journal-config-')); roots.push(root);
  const project = join(root, 'project'); await mkdir(project, { mode: 0o700 });
  const layout = resolveProductLayout({ projectRoot: project });
  return { root, project, env: { HOME: join(root, 'home') }, config: productResourcePath(layout, 'config') };
}

function journal(project: string, config: string, phase: 'pending' | 'committed'): BootstrapJournalPayload {
  return { schemaVersion: 2, transactionId: 'installation-journal-config', planDigest: hex('a'), profileDigest: hex('b'), phase,
    createdAtMs: 1, updatedAtMs: phase === 'pending' ? 1 : 2,
    resources: [{ resource: 'config', path: config, preimageDigest: null, targetDigest: hex('c'),
      state: phase === 'pending' ? 'pending' : 'published' }],
    blockers: phase === 'pending' ? ['INSTALLATION_NOT_APPLIED'] : [],
    recovery: { authoredProfile: { schemaVersion: 1 }, normalizedConfig: { projectName: 'installed-project' },
      approval: { status: 'recorded' }, projectRoot: project } };
}

it('holds cached and fresh config until a real journal producer commits publication', async () => {
  const f = await fixture();
  await expect(loadConfig(f.project, { env: f.env })).resolves.toMatchObject({ projectName: 'deckent-project' });
  await withInstallationJournal(f.project, options, async session => {
    const absent = await session.observe();
    const pending = await session.write(absent, journal(f.project, f.config, 'pending'));
    await expect(loadConfig(f.project, { env: f.env })).rejects.toMatchObject({ code: 'BOOTSTRAP_INSTALLATION_INCOMPLETE' });
    clearConfigCache();
    await expect(loadConfig(f.project, { env: f.env, force: true })).rejects.toMatchObject({ code: 'BOOTSTRAP_INSTALLATION_INCOMPLETE' });
    await writeFile(f.config, JSON.stringify({ projectName: 'installed-project' }), { mode: 0o600 });
    const committed = await session.write(pending, journal(f.project, f.config, 'committed'));
    expect(committed.record?.phase).toBe('committed');
  });
  await expect(loadConfig(f.project, { env: f.env })).resolves.toMatchObject({ projectName: 'installed-project' });
});

function closed(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveClosed, reject) => { child.once('error', reject); child.once('close', () => resolveClosed()); });
}
function ready(child: ChildProcess): Promise<void> {
  return new Promise((resolveReady, reject) => {
    let output = '', stderr = '', settled = false;
    const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer);
      child.stdout?.off('data', onData); child.stderr?.off('data', onErrorData); child.off('close', onClose); child.off('error', onError);
      if (error) reject(error); else resolveReady(); };
    const onData = (chunk: Buffer) => { output += String(chunk); if (output.includes('JOURNAL_PENDING_SYNCED')) finish(); };
    const onErrorData = (chunk: Buffer) => { stderr += String(chunk); };
    const onClose = (code: number | null) => finish(new Error(`CHILD_CLOSED_${code}: ${stderr.slice(-2_000)}`));
    const onError = (error: Error) => finish(error);
    const timer = setTimeout(() => finish(new Error(`CHILD_READY_TIMEOUT: ${stderr.slice(-2_000)}`)), 8_000);
    child.stdout?.on('data', onData); child.stderr?.on('data', onErrorData); child.once('close', onClose); child.once('error', onError);
  });
}

it.skipIf(process.platform === 'win32')('preserves pending recovery across SIGKILL in the compiled adapter', async () => {
  const f = await fixture();
  const program = `
    import { withInstallationJournal } from ${JSON.stringify(pathToFileURL(compiledJournal).href)};
    const [project, config] = process.argv.slice(1), hex = value => value.repeat(64);
    const payload = { schemaVersion: 2, transactionId: 'compiled-installation-journal', planDigest: hex('a'), profileDigest: hex('b'),
      phase: 'pending', createdAtMs: 1, updatedAtMs: 1, resources: [{ resource: 'config', path: config, preimageDigest: null,
      targetDigest: hex('c'), state: 'pending' }], blockers: ['INSTALLATION_NOT_APPLIED'], recovery: { approval: { status: 'recorded' } } };
    await withInstallationJournal(project, { timeoutMs: 10000 }, async session => {
      await session.write(await session.observe(), payload); process.stdout.write('JOURNAL_PENDING_SYNCED\\n');
      await new Promise(resolve => setTimeout(resolve, 60000));
    });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', program, f.project, f.config], {
    cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await ready(child); const closing = closed(child); expect(child.kill('SIGKILL')).toBe(true); await closing;
    expect(child.signalCode).toBe('SIGKILL');
    expect(await observeBootstrapState(f.project)).toMatchObject({ record: { phase: 'pending', transactionId: 'compiled-installation-journal',
      recovery: { approval: { status: 'recorded' } } } });
    await expect(loadConfig(f.project, { env: f.env })).rejects.toMatchObject({ code: 'BOOTSTRAP_INSTALLATION_INCOMPLETE' });
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const closing = closed(child); child.kill('SIGKILL'); await closing.catch(() => undefined); }
  }
});
