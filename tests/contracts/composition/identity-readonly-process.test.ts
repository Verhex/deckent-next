import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, open, readFile, readdir, lstat, rm, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [], cli = resolve('dist/composition/core/cli/internal/entry.js'), mcp = resolve('dist/composition/core/mcp/internal/entry.js');
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-identity-process-')); roots.push(root);
  const project = join(root, 'project'), home = join(root, 'home'); await mkdir(project); await mkdir(home);
  const env = { HOME: home, USERPROFILE: home, DECKENT_GLOBAL_HOME: join(home, 'global'), PATH: process.env.PATH ?? '' };
  // Actual CLI redirection: capture files are outside the observed project/HOME, no child pipe is required.
  async function run(args: string[], entry = cli, input = '') {
    const capture = await mkdtemp(join(root, 'capture-')), output = join(capture, 'stdout'), error = join(capture, 'stderr'), stdin = join(capture, 'stdin');
    await writeFile(stdin, input);
    const handles = await Promise.all([open(stdin, 'r'), open(output, 'w'), open(error, 'w')]);
    try {
      const child = spawn(process.execPath, [entry, ...args], { cwd: project, env, stdio: handles.map(handle => handle.fd) });
      const code = await new Promise<number | null>((accept, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('IDENTITY_PROCESS_TIMEOUT')); }, 10_000);
        child.once('error', failure => { clearTimeout(timer); reject(failure); });
        child.once('close', status => { clearTimeout(timer); accept(status); });
      });
      return { code, stdout: await readFile(output, 'utf8'), stderr: await readFile(error, 'utf8') };
    } finally { await Promise.all(handles.map(handle => handle.close())); }
  }
  return { root, project, home, run };
}
async function snapshot(...paths: string[]) {
  const entries: Record<string, string> = {};
  async function visit(base: string, path: string): Promise<void> {
    const info = await lstat(path), key = `${base}:${relative(base, path) || '.'}`;
    entries[key] = info.isDirectory() ? `directory:${info.mode & 0o777}` : `file:${info.mode & 0o777}:${createHash('sha256').update(await readFile(path)).digest('hex')}`;
    if (info.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(base, join(path, name));
  }
  for (const path of paths) await visit(path, path);
  return entries;
}

it('compiled read-only CLI paths leave fresh project/HOME byte-identical and report identity unavailable', async () => {
  const f = await fixture(), before = await snapshot(f.project, f.home);
  for (const args of [['models', '--json'], ['models', 'binding', '--provider', 'absent', '--provider-version', '1', '--model', 'absent', '--model-version', '1', '--json'],
    ['terminal', 'status', '--json']]) {
    const result = await f.run(args); expect(result.code, result.stderr).toBe(0);
    const data = JSON.parse(result.stdout);
    if (args[0] === 'terminal') expect(data).toMatchObject({ installationId: null, projectId: null, identity: {
      installation: { status: 'unavailable', reason: process.platform === 'win32' ? 'unsupported' : 'not-created' },
      project: { status: 'unavailable', reason: process.platform === 'win32' ? 'unsupported' : 'not-created' } } });
    expect(await snapshot(f.project, f.home)).toEqual(before);
  }
  for (const lang of ['en', 'tr']) {
    const result = await f.run(['terminal', 'status', '--lang', lang]); expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(lang === 'en' ? 'unavailable (' : 'kullanılamıyor (');
    expect(await snapshot(f.project, f.home)).toEqual(before);
  }
});

it.skipIf(process.platform === 'win32')('compiled init preview is read-only; explicit apply creates identities that later status only reads', async () => {
  const f = await fixture(), before = await snapshot(f.project, f.home);
  const preview = await f.run(['init', 'policy', '--scope', 's', '--preview', '--json']);
  expect(preview.code, preview.stderr).toBe(0); expect(JSON.parse(preview.stdout).status).toBe('preview');
  expect(await snapshot(f.project, f.home)).toEqual(before);
  const applied = await f.run(['init', 'policy', '--scope', 's', '--apply', '--json']);
  expect(applied.code, applied.stderr).toBe(0); expect(JSON.parse(applied.stdout).status).toBe('installed');
  const installation = JSON.parse(await readFile(join(f.project, '.deckent/installation-identity/identity.json'), 'utf8'));
  const project = JSON.parse(await readFile(join(f.project, '.deckent/project-identity/identity.json'), 'utf8'));
  const established = await snapshot(f.project, f.home), status = await f.run(['terminal', 'status', '--json']);
  expect(status.code, status.stderr).toBe(0);
  expect(JSON.parse(status.stdout)).toMatchObject({ installationId: installation.installationId, projectId: project.projectId });
  expect(await snapshot(f.project, f.home)).toEqual(established);
});

it('compiled MCP startup and read tool over POSIX stdio leave identity and project/HOME absent', async context => {
  if (process.platform === 'win32') context.skip('POSIX_FIFO_TRANSPORT: standard cross-platform MCP pipe proof remains in declared-models-process');
  const f = await fixture(), before = await snapshot(f.project, f.home), fifo = join(f.root, 'input.fifo');
  // FIFO input and regular-file output exercise actual stdio without the sandbox's socketpair-backed child pipes.
  execFileSync('/usr/bin/mkfifo', [fifo], { stdio: 'ignore' });
  const writer = await open(fifo, 'r+'), input = await open(fifo, 'r'), outputPath = join(f.root, 'mcp-output');
  const output = await open(outputPath, 'w'), errors = await open(join(f.root, 'mcp-errors'), 'w');
  const child = spawn(process.execPath, [mcp, '--project', f.project], { cwd: f.project,
    env: { HOME: f.home, USERPROFILE: f.home, DECKENT_GLOBAL_HOME: join(f.home, 'global'), PATH: process.env.PATH ?? '' },
    stdio: [input.fd, output.fd, errors.fd] });
  const closed = new Promise<number | null>((accept, reject) => { child.once('close', accept); child.once('error', reject); });
  const timer = setTimeout(() => child.kill(), 10_000);
  const readResponse = async (id: number) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const lines = (await readFile(outputPath, 'utf8')).split('\n').filter(Boolean);
      const found = lines.flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }).find(value => value.id === id);
      if (found) return found;
      await sleep(10);
    }
    throw new Error('MCP_READ_RESPONSE_TIMEOUT');
  };
  try {
    await writer.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'identity-readonly-proof', version: '1' } } }) + '\n');
    expect((await readResponse(1)).result).toHaveProperty('protocolVersion');
    await writer.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    await writer.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_declared_models', arguments: {} } }) + '\n');
    const response = await readResponse(2);
    expect(response.result).toMatchObject({ structuredContent: { status: 'not-configured' } });
    expect(response.result.isError).not.toBe(true);
    await writer.close(); expect(await closed).toBe(0);
    expect(await snapshot(f.project, f.home)).toEqual(before);
  } finally {
    clearTimeout(timer); child.kill(); await closed;
    await Promise.all([writer, input, output, errors].map(handle => handle.close()));
  }
}, 15_000);
