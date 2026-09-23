import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { execFile } from 'node:child_process';
import { access, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const execute = promisify(execFile);
const roots: string[] = [];
const cli = resolve('dist/composition/core/cli/internal/entry.js');
const mcp = resolve('dist/composition/core/mcp/internal/entry.js');

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function bounded<T>(promise: Promise<T>, label: string, milliseconds = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(label)), milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
async function fixture() {
  await Promise.all([cli, mcp].map(path => access(path).catch(() => { throw new Error('BUILD_REQUIRED'); })));
  const root = await mkdtemp(join(tmpdir(), 'deckent-bin-entry-'));
  roots.push(root);
  const project = join(root, 'private project ü');
  const home = join(root, 'private home ü');
  await Promise.all([mkdir(project, { mode: 0o700 }), mkdir(home, { mode: 0o700 })]);
  const aliases = join(root, 'links with boşluk');
  await mkdir(aliases, { mode: 0o700 });
  const cliAlias = join(aliases, 'deckent cli ü.js');
  const mcpAlias = join(aliases, 'deckent mcp ü.js');
  await Promise.all([symlink(cli, cliAlias), symlink(mcp, mcpAlias)]);
  return { project, cliAlias, mcpAlias, env: { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin' } };
}

it('runs compiled CLI through a Unicode spaced symlink', async () => {
  const f = await fixture();
  const output = await bounded(execute(process.execPath, [f.cliAlias, '--version'], { cwd: f.project, env: f.env, timeout: 4_000, maxBuffer: 65_536 }),
    'CLI_SYMLINK_TIMEOUT');
  expect(output.stderr).toBe('');
  // The compiled binary also names the exact source tree (and commit when built from a checkout) it was built from.
  expect(output.stdout.trim()).toMatch(/^deckent v\d+\.\d+\.\d+(?:[-+][\w.-]+)? \| Node .+\nbuild [0-9a-f]{12} · commit (?:[0-9a-f]{12}|-)(?: \(uncommitted source changes\))?$/);
});

it('starts compiled MCP through a Unicode spaced symlink and serves initialization/tool discovery', async () => {
  const f = await fixture();
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [f.mcpAlias, '--project', f.project], cwd: f.project, env: f.env, stderr: 'pipe' });
  const diagnostics: Buffer[] = [];
  transport.stderr?.on('data', chunk => diagnostics.push(Buffer.from(chunk)));
  const client = new Client({ name: 'bin-entry-process-test', version: '1' });
  try {
    await bounded(client.connect(transport), 'MCP_SYMLINK_CONNECT_TIMEOUT');
    const tools = await bounded(client.listTools(), 'MCP_SYMLINK_LIST_TIMEOUT');
    expect(tools.tools.map(tool => tool.name)).toContain('policy_vocabulary');
  } finally {
    const failures: unknown[] = [];
    try { await bounded(client.close(), 'MCP_SYMLINK_CLIENT_CLOSE_TIMEOUT'); } catch (error) { failures.push(error); }
    try { await bounded(transport.close(), 'MCP_SYMLINK_TRANSPORT_CLOSE_TIMEOUT'); } catch (error) { failures.push(error); }
    expect(transport.pid).toBeNull();
    expect(failures, Buffer.concat(diagnostics).toString('utf8').slice(-2048)).toEqual([]);
  }
});

it('imports compiled CLI and MCP entry modules without starting either process surface', async () => {
  const f = await fixture();
  const program = `import { pathToFileURL } from 'node:url';
const entry = process.argv[1];
await import(pathToFileURL(entry).href);`;
  for (const entry of [f.cliAlias, f.mcpAlias]) {
    const output = await bounded(execute(process.execPath, ['--input-type=module', '-e', program, entry],
      { cwd: f.project, env: f.env, timeout: 4_000, maxBuffer: 65_536 }), 'ENTRY_IMPORT_TIMEOUT');
    expect(output.stdout).toBe('');
    expect(output.stderr).toBe('');
  }
});

it('supports entry metadata without main while distinguishing symlink startup from eval import', async () => {
  const f = await fixture(), target = join(f.project, 'fallback.mjs'), alias = join(f.project, 'fallback link ü.mjs');
  const platform = pathToFileURL(resolve('dist/platform/index.js')).href;
  await writeFile(target, `import { isMainModule } from ${JSON.stringify(platform)};
process.stdout.write(String(isMainModule({ url: import.meta.url })));`);
  await symlink(target, alias);
  const direct = await execute(process.execPath, [alias], { cwd: f.project, env: f.env, timeout: 4_000 });
  expect(direct.stdout).toBe('true'); expect(direct.stderr).toBe('');
  const imported = await execute(process.execPath, ['--input-type=module', '-e',
    'import { pathToFileURL } from "node:url"; await import(pathToFileURL(process.argv[1]).href);', alias],
  { cwd: f.project, env: f.env, timeout: 4_000 });
  expect(imported.stdout).toBe('false'); expect(imported.stderr).toBe('');
});
