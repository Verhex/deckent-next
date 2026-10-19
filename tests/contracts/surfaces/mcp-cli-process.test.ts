import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { mcpProjectTrustDirectory } from '#adapters/core/mcp-trust/index.js';
import { runConfiguredMcpCommand } from '#composition/core/agent-turn/index.js';
import { clearConfigCache } from '#platform/index.js';

// MCP-CLIENT: the compiled `deckent mcp` commands as a real process over a real project (add → list → approve → list → remove), with a
// real SDK server whose own log shows when it was started.
const CLI = resolve('dist/composition/core/cli/internal/entry.js'), FIXTURE = resolve('tests/fixtures/mcp-stdio-server.mjs');
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

// C-MODELS (owner A48-D5/D6): trust is a person's card on a terminal; off a terminal the compiled CLI refuses it, `--yes` included, before anything starts
// or is written. The trusted half of this flow is decided here through the application with its card answered (the card itself is PTY-proven).
it.skipIf(process.platform !== 'linux')('add, list, approve, get and remove through the compiled CLI; approval without a terminal is refused, --yes included', async () => {
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
  expect(json(run('add', '--scope', 'project', '--realm', 'host', 'fx', '--json', '--', process.execPath, FIXTURE, '--mode', 'legacy', '--tools', tools, '--log', log)))
    .toMatchObject({ added: { name: 'fx', scope: 'project', file: join(project, '.deckent', 'mcp.json') }, trust: 'pending' });
  expect(json(run('list', '--json'))).toMatchObject({ servers: [{ name: 'fx', scope: 'project', status: 'pending-approval', health: 'not-started' }] });
  expect(started()).toBe(0);
  const refused = run('approve', 'fx');
  expect(refused.code).not.toBe(0); expect(refused.err + refused.out).toContain('MCP_APPROVAL_NEEDS_TERMINAL');
  const unattended = run('approve', 'fx', '--yes', '--json');
  expect(unattended.code).toBe(2); expect(unattended.err + unattended.out).toContain('MCP_APPROVAL_NEEDS_TERMINAL');
  const trustFile = async () => join(await mcpProjectTrustDirectory(project, join(home, '.deckent'), false), 'mcp-trust.json');
  expect(started()).toBe(0); expect(existsSync(await trustFile()) ? readFileSync(await trustFile(), 'utf8') : '').not.toContain('"trusted"');
  // A plain list never starts a server; --check starts trusted ones only (fx is still waiting: not started).
  expect(json(run('list', '--check', '--json'))).toMatchObject({ servers: [{ name: 'fx', status: 'pending-approval', health: 'not-started' }] });
  expect(started()).toBe(0);
  clearConfigCache();
  expect(await runConfiguredMcpCommand(project, { verb: 'approve', name: 'fx' }, { env: { HOME: home, PATH: process.env['PATH'] ?? '/usr/bin:/bin' } }, async () => true))
    .toMatchObject({ approved: true, scope: 'project', pinnedTools: 1 });
  const startedAfterCard = started();
  expect(json(run('list', '--json'))).toMatchObject({ servers: [{ name: 'fx', status: 'trusted', health: 'not-started' }] });
  expect(started()).toBe(startedAfterCard);
  expect(json(run('list', '--check', '--json'))).toMatchObject({ servers: [{ name: 'fx', status: 'trusted', health: 'connected', era: 'legacy' }] });
  expect(json(run('get', 'fx', '--json'))).toMatchObject({ server: { name: 'fx', trust: { tools: [{ name: 'echo' }] } } });
  expect(json(run('remove', 'fx', '--json'))).toMatchObject({ removed: { name: 'fx', scope: 'project' } });
  // A personal add is its trust decision: without a terminal it is refused, --yes included (nothing is written before).
  for (const extra of [[], ['--yes']]) {
    const personal = run('add', ...extra, '--realm', 'host', 'lx', '--', process.execPath, FIXTURE, '--mode', 'legacy', '--tools', tools, '--log', log);
    expect(personal.code).toBe(2); expect(personal.err + personal.out).toContain('MCP_APPROVAL_NEEDS_TERMINAL');
  }
  expect(existsSync(join(home, '.deckent', 'mcp.json'))).toBe(false);
  clearConfigCache();
  expect(await runConfiguredMcpCommand(project, { verb: 'add', scope: 'local', name: 'lx', approve: true, entry: { command: process.execPath, args: [FIXTURE, '--mode', 'legacy', '--tools', tools, '--log', log], realm: 'host' } },
    { env: { HOME: home, PATH: process.env['PATH'] ?? '/usr/bin:/bin' } }, async () => true)).toMatchObject({ added: { name: 'lx', scope: 'local' }, trust: 'trusted', pinnedTools: 1 });
  const gone = run('get', 'fx');
  expect(gone.code).not.toBe(0); expect(gone.err + gone.out).toContain('MCP_SERVER_UNKNOWN');
  // SEC-2 (F29): local and project trust live in the global root's directory of this project, never in the project tree.
  expect(existsSync(join(project, '.deckent', 'integrations', 'mcp-trust.json'))).toBe(false);
  expect(JSON.parse(readFileSync(join(await mcpProjectTrustDirectory(project, join(home, '.deckent'), false), 'mcp-trust.json'), 'utf8')))
    .toMatchObject({ servers: [{ name: 'lx', scope: 'local', decision: 'trusted' }] });
}, 120_000);
