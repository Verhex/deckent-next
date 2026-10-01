import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeWorkspaceFileHost, createWorkspaceReadTools, createWorkspaceScope, indexWorkspaceFiles, readWorkspaceAttachment } from '#adapters/index.js';

// On Linux this models a host without proc descriptor paths. Other hosts exercise their
// actual unsupported platform guard; neither is a macOS custody implementation proof.
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: (path: import('node:fs').PathLike) => path === '/proc/self/fd' ? false : actual.existsSync(path) };
});

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-unsupported-read-')); roots.push(root);
  await writeFile(join(root, 'note.txt'), 'WORKSPACE-CONTENT-SENTINEL');
  return root;
}

describe(process.platform === 'linux' ? 'workspace refusal: simulated missing /proc/self/fd on Linux' : `workspace refusal: native unsupported ${process.platform}`, () => {
  it('refuses resolving and opening real content, and every read tool reports platform-unsupported', async () => {
    const root = await workspace(), scope = await createWorkspaceScope(root);
    await expect(scope.resolve('note.txt')).resolves.toEqual({ ok: false, error: 'platform-unsupported' });
    await expect(scope.open('note.txt', 'file')).resolves.toEqual({ ok: false, error: 'platform-unsupported' });
    const tools = await createWorkspaceReadTools(root);
    for (const [name, args] of [['read_file', { path: 'note.txt' }], ['list_dir', {}], ['grep', { pattern: 'SENTINEL' }], ['glob', { pattern: '**/*' }]] as const) {
      const result = await tools.execute(name, args);
      expect(result.status, name).toBe('error');
      expect(result.text, name).toContain('error=platform-unsupported');
      expect(result.text, name).not.toContain('WORKSPACE-CONTENT-SENTINEL');
    }
    await expect(readWorkspaceAttachment(scope, 'note.txt', 1024)).resolves.toEqual({ status: 'refused', path: 'note.txt', reason: 'platform-unsupported' });
    expect(await readFile(join(root, 'note.txt'), 'utf8')).toBe('WORKSPACE-CONTENT-SENTINEL');
  });

  it('reports an incomplete empty index to the composer and runtime cache, never a healthy empty workspace', async () => {
    const root = await workspace(), scope = await createWorkspaceScope(root);
    await expect(indexWorkspaceFiles(scope)).resolves.toEqual({ paths: [], truncated: false, incomplete: true });
    const host = createRuntimeWorkspaceFileHost();
    await expect(host.index(root, [])).resolves.toEqual({ paths: [], truncated: false, incomplete: true });
    await expect(host.index(root, [])).resolves.toEqual({ paths: [], truncated: false, incomplete: true });
  });
});
