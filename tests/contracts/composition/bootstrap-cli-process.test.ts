import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { encodeBootstrapJournal, productResourcePath, resolveProductLayout } from '#platform/index.js';

const execute = promisify(execFile), cli = resolve('dist/composition/core/cli/internal/entry.js');
it('compiled CLI rejects incomplete installation before autoheal and keeps global inspection independent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-bootstrap-cli-'));
  try {
    const project = join(root, 'project'); await mkdir(project);
    const layout = resolveProductLayout({ projectRoot: project });
    const journal = productResourcePath(layout, 'installationJournal'), config = productResourcePath(layout, 'config');
    await mkdir(dirname(journal), { recursive: true, mode: 0o700 }); await writeFile(config, '{', { mode: 0o600 });
    const payload = { schemaVersion: 2 as const, transactionId: 'cli-partial-install', planDigest: 'a'.repeat(64), profileDigest: 'b'.repeat(64),
      phase: 'pending' as const, createdAtMs: 0, updatedAtMs: 0, resources: [{ resource: 'config', path: config,
      preimageDigest: null, targetDigest: 'c'.repeat(64), state: 'pending' as const }], blockers: ['IMAGE_PROVENANCE_UNVERIFIED'], recovery: {} };
    const bytes = encodeBootstrapJournal(payload);
    await writeFile(journal, bytes, { mode: 0o600 });
    const env = { ...process.env, HOME: join(root, 'home'), DECKENT_HOME: join(root, 'relocated') };
    const run = (args: string[]) => execute(process.execPath, [cli, ...args], { cwd: project, env, timeout: 5000, maxBuffer: 1048576 });
    let observed = false;
    try { await run(['config', 'get', '--json']); }
    catch (error) {
      const failure = error as { code: number; stdout: string; stderr: string };
      expect(failure.code).toBe(78); expect(failure.stdout).toBe('');
      expect(JSON.parse(failure.stderr)).toMatchObject({ code: 'BOOTSTRAP_INSTALLATION_INCOMPLETE' }); observed = true;
    }
    expect(observed).toBe(true);
    const global = await run(['config', 'get', 'schema_version', '--global', '--json']); expect(JSON.parse(global.stdout)).toBe(2);
    expect(await readFile(config, 'utf8')).toBe('{'); expect(await readFile(journal, 'utf8')).toBe(bytes);
    expect((await readdir(dirname(config))).sort()).toEqual(['config.json', 'installation']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
