import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPolicyTemplateInstallation } from '#composition/core/installation/index.js';
import { configuredProjectInstructions } from '#composition/core/project-instructions/index.js';
import { openConfiguredAttemptStore } from '#composition/core/storage/index.js';
import { clearConfigCache } from '#platform/index.js';
import { projectSkeleton } from '#surfaces/core/project-instructions/index.js';
import { terminalApplication } from '../support/approval-terminal.js';
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), 'instruction-init-')); roots.push(folder);
  const root = join(folder, 'project'), home = join(folder, 'home'); await mkdir(root); await mkdir(home, { mode: 0o700 });
  await applyPolicyTemplateInstallation(root, 'installation');
  await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ terminal: { scopeId: 'installation' } }), { mode: 0o600 });
  const options = { env: { HOME: home } };
  const opened = await openConfiguredAttemptStore(root, options); opened.store.close();
  const port = await configuredProjectInstructions(root, options);
  return { root, port, ledger: opened.path, options };
}
describe.skipIf(process.platform !== 'linux')('init through the existing scoped file effect and approval broker', () => {
  it('creates only AGENTS through the approved file effect and preserves both existing standard files', async () => {
    const f = await fixture();
    // W3-AUTHORITY: confirmation and its governed approval execute in a real terminal; preview is issued in that same process.
    expect(await terminalApplication({ project: f.root, env: f.options.env }, 'project-init', 'installation',
      { bridges: [], locale: 'en' })).toEqual([{ path: 'AGENTS.md', status: 'settled' }]);
    expect(await readFile(join(f.root, 'AGENTS.md'), 'utf8')).toContain('# project');
    await expect(readFile(join(f.root, 'DECKENT.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(join(f.root, 'CLAUDE.md'), 'preserve these bytes');
    expect((await f.port.preview([], projectSkeleton('en'))).changes).toEqual([]);
    expect(await readFile(join(f.root, 'CLAUDE.md'), 'utf8')).toBe('preserve these bytes');
    const db = new DatabaseSync(f.ledger, { readOnly: true });
    try {
      const effects = db.prepare('SELECT state FROM effect_intents').all();
      expect(effects.filter(row => row['state'] === 'settled')).toHaveLength(1);
      expect(db.prepare('SELECT COUNT(*) AS n FROM approvals').get()?.['n']).toBe(1);
    } finally { db.close(); }
  });
  it('refuses noninteractive initialization before publishing a file and retains its pending approval', async () => {
    const f = await fixture(), preview = await f.port.preview([], projectSkeleton('en'));
    await expect(f.port.initialize(preview)).rejects.toMatchObject({ code: 'APPROVAL_INTERACTIVE_REQUIRED' });
    await expect(readFile(join(f.root, 'AGENTS.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    const db = new DatabaseSync(f.ledger, { readOnly: true });
    try { expect(db.prepare("SELECT json_extract(snapshot,'$.status') AS status FROM approvals").all()).toEqual([{ status: 'pending' }]); }
    finally { db.close(); }
  });
  it('refuses a raced preview before touching any proposed file', async () => {
    const f = await fixture(), preview = await f.port.preview([], projectSkeleton('en'));
    await writeFile(join(f.root, 'AGENTS.md'), 'concurrent edit');
    await expect(f.port.initialize(preview)).rejects.toThrow('unsafe');
    expect(await readFile(join(f.root, 'AGENTS.md'), 'utf8')).toBe('concurrent edit');
    await expect(readFile(join(f.root, 'DECKENT.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('refuses fabricated or mutated previews and never converts preview context into authority', async () => {
    const f = await fixture(), preview = await f.port.preview([], projectSkeleton('en'));
    await expect(f.port.initialize({ ...preview })).rejects.toThrow('unsafe');
    (preview as { digest: string }).digest = '0'.repeat(64);
    await expect(f.port.initialize(preview)).rejects.toThrow('unsafe');
    await expect(readFile(join(f.root, 'AGENTS.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('keeps trust out of the workspace even when the installation has a project root override', async () => {
    const f = await fixture(); await writeFile(join(f.root, 'DECKENT.md'), 'context');
    const options = { env: { ...f.options.env, DECKENT_HOME: join(f.root, '.deckent') } };
    const port = await configuredProjectInstructions(f.root, options), first = await port.inspect();
    if (!('source' in first)) throw new Error('source');
    expect(await port.trust(first.source.digest)).toMatchObject({ status: 'ready' });
    expect(await (await configuredProjectInstructions(f.root, options)).inspect()).toMatchObject({ status: 'ready' });
    await expect(readFile(join(f.root, '.deckent/state/instruction-trust'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
