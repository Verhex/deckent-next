import { mkdtemp, mkdir, rm, writeFile, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkspaceScope, indexWorkspaceFiles, rankWorkspacePaths, readWorkspaceAttachment } from '#adapters/index.js';
import { attachTerminalMentions, TERMINAL_MENTION_MAX_FILES } from '#surfaces/core/terminal-turn/index.js';

import { WORKSPACE_DESCRIPTOR_CUSTODY_AVAILABLE } from '../../fixtures/workspace-descriptor-custody.js';

const custodyIt = it.skipIf(!WORKSPACE_DESCRIPTOR_CUSTODY_AVAILABLE);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function project(files: Record<string, string | Buffer>) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-mentions-')); roots.push(root);
  for (const [path, body] of Object.entries(files)) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), body); }
  return root;
}

describe('workspace @file index, ranking and bounded attachment (T-L5)', () => {
  it('ranks a file-name match before a path match, prefix before substring before subsequence, shallow and short first', () => {
    const paths = ['src/terminal/composer.tsx', 'docs/composer-notes.md', 'src/compose.ts', 'lib/x/compose.ts', 'src/cmp/other.ts', 'composer/index.ts'];
    expect(rankWorkspacePaths(paths, 'compose', 10)).toEqual(['src/compose.ts', 'lib/x/compose.ts', 'docs/composer-notes.md', 'src/terminal/composer.tsx', 'composer/index.ts']);
    expect(rankWorkspacePaths(paths, 'COMPOSER', 2)).toEqual(['src/terminal/composer.tsx', 'docs/composer-notes.md']);
    // A path query ranks the path substring first; segment-wise subsequences follow.
    expect(rankWorkspacePaths(paths, 'src/cmp', 10)[0]).toBe('src/cmp/other.ts');
    expect(rankWorkspacePaths(paths, 'stc', 10)).toEqual(['src/terminal/composer.tsx']);
    expect(rankWorkspacePaths(paths, '', 2)).toEqual(['src/compose.ts', 'composer/index.ts']);
  });

  custodyIt('[requires Linux /proc/self/fd custody] indexes regular files only, skipping the deny floor and ignored directories, and stops at its bound', async () => {
    const root = await project({ 'a.ts': 'a', '.env': 'S=1', 'node_modules/p/i.js': 'x', '.git/HEAD': 'ref', 'dir/b.ts': 'b', 'dir/c.ts': 'c' });
    const scope = await createWorkspaceScope(root);
    expect([...(await indexWorkspaceFiles(scope)).paths].sort()).toEqual(['a.ts', 'dir/b.ts', 'dir/c.ts']);
    expect(await indexWorkspaceFiles(scope, 2)).toMatchObject({ truncated: true, paths: ['a.ts', 'dir/b.ts'] });
  });

  custodyIt('[requires Linux /proc/self/fd custody] attaches a bounded UTF-8 prefix and says so; refuses denied, binary, hard-linked and outside paths with a typed reason', async () => {
    const root = await project({ 'tr.txt': 'ğ'.repeat(10), 'bin.dat': Buffer.from([1, 0, 2]), '.env': 'S=1', 'small.ts': 'ok\n' });
    await link(join(root, 'small.ts'), join(root, 'alias.ts'));
    const scope = await createWorkspaceScope(root);
    // 'ğ' is two bytes: a 5-byte bound keeps two whole letters, never half of one.
    expect(await readWorkspaceAttachment(scope, 'tr.txt', 5)).toEqual({ status: 'attached', path: 'tr.txt', content: 'ğğ', bytes: 4, totalBytes: 20, truncated: true });
    expect(await readWorkspaceAttachment(scope, 'bin.dat', 100)).toMatchObject({ status: 'refused', reason: 'binary' });
    expect(await readWorkspaceAttachment(scope, '.env', 100)).toMatchObject({ status: 'refused', reason: 'path-denied' });
    expect(await readWorkspaceAttachment(scope, '../etc/passwd', 100)).toMatchObject({ status: 'refused', reason: 'path-outside-workspace' });
    expect(await readWorkspaceAttachment(scope, 'alias.ts', 100)).toMatchObject({ status: 'refused', reason: 'hardlink-refused' });
    expect(await readWorkspaceAttachment(scope, 'missing.ts', 100)).toMatchObject({ status: 'refused', reason: 'not-found' });
  });

  it('attaches at most 8 files and 128 KiB per message, labels each block and reports what was left out', async () => {
    const asked: number[] = [];
    const ports = { find: async () => ({ schemaVersion: 1 as const, paths: [], truncated: false, incomplete: false }),
      attach: async (_root: string, request: { path: string; maxBytes: number }) => {
        asked.push(request.maxBytes);
        return request.path === 'no' ? { schemaVersion: 1 as const, path: 'no', status: 'refused' as const, reason: 'not-found' as const }
          : { schemaVersion: 1 as const, path: request.path, status: 'attached' as const, content: 'y'.repeat(request.maxBytes), bytes: request.maxBytes,
            totalBytes: 40_000, truncated: request.maxBytes < 40_000 };
      } };
    const paths = ['no', ...Array.from({ length: 9 }, (_, index) => `f${index}`)];
    const result = await attachTerminalMentions({ projectRoot: '/p', scopeId: 's', text: 'hi', paths, options: {} }, ports);
    expect(TERMINAL_MENTION_MAX_FILES).toBe(8);
    // 32 KiB each until 128 KiB are used; the rest is reported as left out.
    expect(asked).toEqual([32_768, 32_768, 32_768, 32_768, 32_768]);
    expect(result.notes.map(note => note.status === 'refused' ? `${note.path}:${note.reason}` : `${note.path}:${note.bytes}`)).toEqual(['no:not-found',
      'f0:32768', 'f1:32768', 'f2:32768', 'f3:32768', 'f4:limit', 'f5:limit', 'f6:limit', 'f7:limit', 'f8:limit']);
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThan(131_072 + 2_000);
    expect(result.content).toContain('--- attached file f0 (first 32768 of 40000 bytes; the rest was not attached) ---');
  });
});
