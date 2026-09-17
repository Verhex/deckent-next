import { mkdtemp, readdir, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { inspectProductPaths } from '../../src/platform/index.js';

const exec = promisify(execFile), binary = fileURLToPath(new URL('../../dist/composition/core/cli/internal/entry.js', import.meta.url));
describe('shared product path inspection', () => {
  it('prints the same revision and locations as the public API without creating product data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-path-query-'));
    try {
      const env = { HOME: root, USERPROFILE: root, PATH: process.env['PATH'] };
      const result = await exec(process.execPath, [binary, 'paths', '--json'], { cwd: root, env });
      expect(JSON.parse(result.stdout)).toEqual(await inspectProductPaths(root, { env }));
      expect(JSON.parse(result.stdout).resources.memory).toBe(join(root, '.deckent', 'brain', 'memory.db'));
      expect(await readdir(root)).toEqual([]);
      await expect(exec(process.execPath, [binary, 'paths', 'extra', '--json'], { cwd: root, env })).rejects.toMatchObject({ code: 2 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('keeps the locator fixed, reports relocated resources, and never follows a second config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-relocated-'));
    try {
      const env = { HOME: root, USERPROFILE: root, PATH: process.env['PATH'] };
      const locator = join(root, '.deckent', 'config.json'), data = join(root, 'data');
      await mkdir(join(root, '.deckent')); await mkdir(data);
      const source = JSON.stringify({ layout: { root: data, resources: { memory: 'learning/memory.db' } } });
      await writeFile(locator, source);
      await writeFile(join(data, 'config.json'), JSON.stringify({ layout: { root: join(root, 'wrong') } }));
      const result = await exec(process.execPath, [binary, 'paths', '--json'], { cwd: root, env });
      const actual = JSON.parse(result.stdout);
      expect(actual).toEqual(await inspectProductPaths(root, { env }));
      expect(actual.bootstrapConfigPath).toBe(locator);
      expect(actual.resources.config).toBe(locator);
      expect(actual.resources.memory).toBe(join(data, 'learning', 'memory.db'));
      expect(actual.root).toBe(data);
      expect(await readFile(locator, 'utf8')).toBe(source);
      expect(await readdir(data)).toEqual(['config.json']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

});
