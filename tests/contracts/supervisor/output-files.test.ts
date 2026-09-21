import { mkdtemp, mkdir, writeFile, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { collectDockerOutputFiles, dockerOutputFilesSchema } from '../../../src/adapters/core/docker-supervisor/index.js';

describe.skipIf(process.platform !== 'linux')('stopped workspace file collection', () => {
  it('reads binary bytes while refusing symlinks, hardlinks, directories, FIFOs, missing and oversize files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-output-files-'));
    try {
      const workspace = join(root, 'workspace'); await mkdir(workspace); await mkdir(join(workspace, 'nested'));
      const bytes = Buffer.from([0, 255, 1, 13, 10]); await writeFile(join(workspace, 'nested', 'valid'), bytes);
      await writeFile(join(root, 'secret'), 'secret'); await symlink(join(root, 'secret'), join(workspace, 'sym'));
      await symlink(root, join(workspace, 'parent')); await link(join(root, 'secret'), join(workspace, 'hard'));
      await writeFile(join(workspace, 'large'), 'longer-than-limit'); execFileSync('mkfifo', [join(workspace, 'fifo')]);
      const names = ['nested/valid', 'sym', 'parent/secret', 'hard', 'large', 'missing', 'nested', 'fifo'];
      const output = await collectDockerOutputFiles(workspace, { maxBytes: 64, maxFiles: 8,
        files: names.map((path, index) => ({ name: `file${index}`, path, maxBytes: 8 })) });
      expect(output[0]).toEqual({ name: 'file0', status: 'collected', bytes });
      expect(output.slice(1).map(file => file.status === 'unavailable' && file.reason))
        .toEqual(['unsafe', 'unsafe', 'unsafe', 'too-large', 'missing', 'unsafe', 'unsafe']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('rejects path traversal, ambiguous names and declared budgets above aggregate limits', () => {
    const file = { name: 'report', path: 'report.json', maxBytes: 8 };
    const input = { maxBytes: 8, maxFiles: 1, files: [file] };
    expect(dockerOutputFilesSchema.parse(input)).toEqual(input);
    for (const path of ['../secret', '/secret', 'a/../secret', 'a//b', './a', 'a\\b']) {
      expect(() => dockerOutputFilesSchema.parse({ ...input, files: [{ ...file, path }] })).toThrow();
    }
    for (const value of [{ ...input, maxBytes: 7 }, { ...input, files: [file, file] },
      { ...input, maxBytes: 16, maxFiles: 2, files: [file, file] }]) expect(() => dockerOutputFilesSchema.parse(value)).toThrow();
  });
});
