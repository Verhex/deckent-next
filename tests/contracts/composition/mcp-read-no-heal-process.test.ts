import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [], mcp = resolve('dist/composition/core/mcp/internal/entry.js');
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

// A read-only MCP inspect must never repair the project config: a config corrupted after the server started is refused with the
// typed CONFIG_FILE_INVALID refusal, and the file bytes stay exactly as found (no backup, no defaults written).
it('refuses inspect_toolchain_currency on a corrupt project config without healing or writing a backup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-mcp-noheal-')); roots.push(root);
  const project = join(root, 'project'), home = join(root, 'home'); await mkdir(project, { mode: 0o700 }); await mkdir(home, { mode: 0o700 });
  await mkdir(join(project, '.deckent'), { mode: 0o700 }); const path = join(project, '.deckent/config.json');
  await writeFile(path, JSON.stringify({ layout: { root: join(root, 'data') } }), { mode: 0o600 });
  const env = { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? '/usr/bin:/bin' };
  const transport = new StdioClientTransport({ command: process.execPath, args: [mcp, '--project', project], env, stderr: 'pipe' });
  const client = new Client({ name: 'mcp-read-no-heal', version: '1' });
  try {
    await client.connect(transport);
    const corrupt = '{"toolchains":'; await writeFile(path, corrupt, { mode: 0o600 });
    const called = await client.callTool({ name: 'inspect_toolchain_currency', arguments: {} });
    expect(called.isError).toBe(true);
    expect(JSON.stringify(called)).toContain('CONFIG_FILE_INVALID');
    expect(await readFile(path, 'utf8')).toBe(corrupt);
    expect((await readdir(join(project, '.deckent'))).sort()).toEqual(['config.json']);
  } finally { await client.close().catch(() => undefined); await transport.close().catch(() => undefined); }
}, 30_000);
