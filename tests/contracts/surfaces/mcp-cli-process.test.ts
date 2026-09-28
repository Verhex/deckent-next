import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

// MCP-CLIENT: the compiled `deckent mcp` commands as a real process over a real project (add → list → approve → list → remove), with a
// real SDK server whose own log shows when it was started.
const CLI = resolve('dist/composition/core/cli/internal/entry.js'), FIXTURE = resolve('tests/fixtures/mcp-stdio-server.mjs');
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it.skipIf(process.platform !== 'linux')('add, list, approve, get and remove through the compiled CLI; approval without a terminal needs --yes', () => {
  const base = mkdtempSync(join(tmpdir(), 'deckent-mcp-cli-')); roots.push(base);
  const project = join(base, 'project'), home = join(base, 'home'), tools = join(base, 'tools.json'), log = join(base, 'log.jsonl');
  mkdirSync(join(project, '.deckent'), { recursive: true }); mkdirSync(home, { mode: 0o700 });
  writeFileSync(join(project, '.deckent', 'config.json'), '{}\n'); appendFileSync(log, '');
  writeFileSync(tools, JSON.stringify([{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: {} } }]));
  const run = (...argv: string[]) => {
    const result = spawnSync(process.execPath, [CLI, 'mcp', ...argv], { cwd: project, env: { HOME: home, PATH: process.env['PATH'] ?? '/usr/bin:/bin' }, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
    return { code: result.status, out: result.stdout, err: result.stderr };
  };
  const json = (result: ReturnType<typeof run>) => { expect(result.code, result.err).toBe(0); return JSON.parse(result.out) as Record<string, unknown>; };
  const started = () => readFileSync(log, 'utf8').split('\n').filter(line => line.includes('"start"')).length;
  expect(json(run('add', '--scope', 'project', '--realm', 'host', 'fx', '--', process.execPath, FIXTURE, '--mode', 'legacy', '--tools', tools, '--log', log)))
    .toMatchObject({ added: { name: 'fx', scope: 'project', file: join(project, '.deckent', 'mcp.json') }, trust: 'pending' });
  expect(json(run('list', '--json'))).toMatchObject({ servers: [{ name: 'fx', scope: 'project', status: 'pending-approval', health: 'not-started' }] });
  expect(started()).toBe(0);
  const refused = run('approve', 'fx');
  expect(refused.code).not.toBe(0); expect(refused.err + refused.out).toContain('MCP_APPROVAL_NEEDS_TERMINAL');
  expect(json(run('approve', 'fx', '--yes', '--json'))).toMatchObject({ approved: true, scope: 'project', pinnedTools: 1 });
  expect(json(run('list', '--json'))).toMatchObject({ servers: [{ name: 'fx', status: 'trusted', health: 'connected', era: 'legacy' }] });
  expect(json(run('get', 'fx', '--json'))).toMatchObject({ server: { name: 'fx', trust: { tools: [{ name: 'echo' }] } } });
  expect(json(run('remove', 'fx', '--json'))).toMatchObject({ removed: { name: 'fx', scope: 'project' } });
  // A personal add is its trust decision: without a terminal it needs --yes (nothing is written before).
  const personal = run('add', '--realm', 'host', 'lx', '--', process.execPath, FIXTURE, '--mode', 'legacy', '--tools', tools, '--log', log);
  expect(personal.code).not.toBe(0); expect(personal.err + personal.out).toContain('MCP_APPROVAL_NEEDS_TERMINAL');
  expect(json(run('add', '--yes', '--realm', 'host', 'lx', '--json', '--', process.execPath, FIXTURE, '--mode', 'legacy', '--tools', tools, '--log', log)))
    .toMatchObject({ added: { name: 'lx', scope: 'local' }, trust: 'trusted', pinnedTools: 1 });
  const gone = run('get', 'fx');
  expect(gone.code).not.toBe(0); expect(gone.err + gone.out).toContain('MCP_SERVER_UNKNOWN');
  expect(JSON.parse(readFileSync(join(project, '.deckent', 'integrations', 'mcp-trust.json'), 'utf8'))).toMatchObject({ servers: [{ name: 'lx', scope: 'local', decision: 'trusted' }] });
}, 120_000);
