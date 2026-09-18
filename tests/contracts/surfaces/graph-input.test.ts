import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, it } from 'vitest';
import { readGraphInput } from '../../../src/surfaces/core/cli/index.js';
import { CONFIG_FIELDS } from '#platform/core/config-fields/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root() { const value = await mkdtemp(join(tmpdir(), 'deckent-graph-input-')); roots.push(value); return value; }
const code = (error: unknown) => (error as { code?: string }).code;

it('reads identical bounded JSON from a regular file and piped stdin', async () => {
  const path = join(await root(), 'graph.json'); const graph = { schemaVersion: 2, revision: 1, tasks: [] };
  await writeFile(path, JSON.stringify(graph));
  await expect(readGraphInput(path, 1024)).resolves.toEqual(graph);
  await expect(readGraphInput('-', 1024, Readable.from([JSON.stringify(graph)]))).resolves.toEqual(graph);
});

it('accepts exactly the byte limit and rejects streams or files that exceed it', async () => {
  const value = '{"ok":true}'; const path = join(await root(), 'exact.json'); await writeFile(path, value);
  await expect(readGraphInput(path, Buffer.byteLength(value))).resolves.toEqual({ ok: true });
  await expect(readGraphInput('-', Buffer.byteLength(value) - 1, Readable.from([value]))).rejects.toSatisfy(error => code(error) === 'CLI_GRAPH_INPUT_LIMIT');
  await writeFile(path, value + ' ');
  await expect(readGraphInput(path, Buffer.byteLength(value))).rejects.toSatisfy(error => code(error) === 'CLI_GRAPH_INPUT_LIMIT');
});

it('rejects invalid UTF-8 and invalid JSON without parsing a partial graph', async () => {
  await expect(readGraphInput('-', 16, Readable.from([Buffer.from([0xc3])]))).rejects.toSatisfy(error => code(error) === 'CLI_GRAPH_INPUT_INVALID');
  await expect(readGraphInput('-', 16, Readable.from(['{"task":'] ))).rejects.toSatisfy(error => code(error) === 'CLI_GRAPH_INPUT_INVALID');
});

it('rejects symlinks, directories, and missing paths without following or exposing them', async () => {
  const base = await root(); const target = join(base, 'target.json'); const link = join(base, 'link.json'); const directory = join(base, 'directory');
  await writeFile(target, '{"safe":true}'); await symlink(target, link); await mkdir(directory);
  await expect(readGraphInput(link, 1024)).rejects.toSatisfy(error => code(error) === 'CLI_GRAPH_INPUT_UNAVAILABLE');
  await expect(readGraphInput(directory, 1024)).rejects.toSatisfy(error => code(error) === 'CLI_GRAPH_INPUT_INVALID');
  await expect(readGraphInput(join(base, 'missing.json'), 1024)).rejects.toSatisfy(error => code(error) === 'CLI_GRAPH_INPUT_UNAVAILABLE');
});

it('refuses interactive stdin rather than waiting for input', async () => {
  const tty = Object.assign(Readable.from([]), { isTTY: true });
  await expect(readGraphInput('-', 1024, tty)).rejects.toSatisfy(error => code(error) === 'CLI_GRAPH_INPUT_TTY');
});

it('defaults and validates the CLI graph input byte limit', () => {
  const schema = CONFIG_FIELDS.cli.schema;
  expect(schema.parse(undefined)).toEqual({ graphInputMaxBytes: 1048576 });
  expect(schema.parse({ graphInputMaxBytes: 7 })).toEqual({ graphInputMaxBytes: 7 });
  expect(() => schema.parse({ graphInputMaxBytes: 0 })).toThrow();
});
