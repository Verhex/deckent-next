import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { inspectProductPaths } from '../../src/platform/core/host/index.js';

const exec = promisify(execFile), binary = fileURLToPath(new URL('../../dist/composition/core/cli/internal/entry.js', import.meta.url));
describe('shared product path inspection', () => {
  it('prints the same revision and locations as the public API without creating product data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-path-query-'));
    try {
      const env = { HOME: root, USERPROFILE: root, PATH: process.env['PATH'] };
      const result = await exec(process.execPath, [binary, 'paths', '--json'], { cwd: root, env });
      expect(JSON.parse(result.stdout)).toEqual(inspectProductPaths(root, { env }));
      expect(JSON.parse(result.stdout).resources.memory).toBe(join(root, '.deckent', 'brain', 'memory.db'));
      expect(await readdir(root)).toEqual([]);
      await expect(exec(process.execPath, [binary, 'paths', 'extra', '--json'], { cwd: root, env })).rejects.toMatchObject({ code: 2 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
