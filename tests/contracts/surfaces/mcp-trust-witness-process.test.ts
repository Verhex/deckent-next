import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runConfiguredMcpCommand } from '#composition/core/agent-turn/index.js';
import { clearConfigCache } from '#platform/index.js';
import { lastJson, runInTerminal } from '../support/terminal-cli.js';

// SEC-1 (owner A48-D5, lead note from HANDOFF-SEC-2 item 5) × C-MODELS (lead J2e decisions 1 and 3): MCP server trust is an authority write. Two
// layers answer, and this test pins which one: from a pipe (a script, an agent's shell) the CLI refuses first with MCP_APPROVAL_NEEDS_TERMINAL,
// `--yes` included; the application behind it keeps the witness as the backstop for any other non-TTY caller (AUTHORITY_WITNESS_REQUIRED). Neither
// asks a card, starts the server or writes trust. On a real PTY `--yes` no longer skips the card: the person answers it and the server is trusted.
// Location-agnostic: the result is read back through `mcp list`, and the server's own log shows whether it was started.
const CLI = resolve('dist/composition/core/cli/internal/entry.js'), FIXTURE = resolve('tests/fixtures/mcp-stdio-server.mjs');
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it.skipIf(process.platform !== 'linux')('a non-TTY `mcp approve --yes` is refused by the CLI and, behind it, by the witness; on a real terminal the card decides', async () => {
  const base = mkdtempSync(join(tmpdir(), 'deckent-mcp-witness-')); roots.push(base);
  const project = join(base, 'project'), home = join(base, 'home'), tools = join(base, 'tools.json'), log = join(base, 'log.jsonl');
  mkdirSync(join(project, '.deckent'), { recursive: true }); mkdirSync(home, { mode: 0o700 });
  writeFileSync(join(project, '.deckent', 'config.json'), '{}\n'); appendFileSync(log, '');
  writeFileSync(tools, JSON.stringify([{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: {} } }]));
  const env = { HOME: home, PATH: process.env['PATH'] ?? '/usr/bin:/bin', DECKENT_LANGUAGE: 'en', NO_COLOR: '1' };
  const runAt = (cwd: string, ...argv: string[]) => {
    const result = spawnSync(process.execPath, [CLI, 'mcp', ...argv], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
    return { code: result.status, out: result.stdout, err: result.stderr };
  };
  const run = (...argv: string[]) => runAt(project, ...argv);
  const started = () => readFileSync(log, 'utf8').split('\n').filter(line => line.includes('"start"')).length;
  const status = () => (JSON.parse(run('list', '--json').out) as { servers: { name: string; status: string }[] }).servers.find(server => server.name === 'fx')?.status;
  // A project entry (the shape a cloned repository ships) is pending until the owner approves it.
  const addProject = ['add', '--scope', 'project', '--realm', 'host', 'fx', '--', process.execPath, FIXTURE, '--mode', 'legacy', '--tools', tools, '--log', log];
  expect(run(...addProject).code).toBe(0);
  expect(status()).toBe('pending-approval');
  // Layer 1, the CLI: from a pipe with --yes, refused, typed; no card asked, no server started, no trust recorded.
  const refused = run('approve', 'fx', '--yes', '--json');
  expect(refused.code).toBe(2);
  expect(refused.err + refused.out).toContain('MCP_APPROVAL_NEEDS_TERMINAL'); expect(refused.err + refused.out).not.toContain('AUTHORITY_WITNESS_REQUIRED');
  expect(started()).toBe(0);
  expect(status()).toBe('pending-approval');
  // A personal add is its own trust decision: the same refusal, and no registry entry lands.
  const personal = run('add', '--yes', '--realm', 'host', 'lx', '--json', '--', process.execPath, FIXTURE, '--mode', 'legacy', '--tools', tools, '--log', log);
  expect(personal.code).toBe(2); expect(personal.err + personal.out).toContain('MCP_APPROVAL_NEEDS_TERMINAL');
  expect(run('get', 'lx').err).toContain('MCP_SERVER_UNKNOWN');
  // Layer 2, the application behind every surface: a caller without a terminal is refused even with the card answered yes.
  const asked: unknown[] = [];
  await expect(runConfiguredMcpCommand(project, { verb: 'approve', name: 'fx' }, { env }, async card => { asked.push(card); return true; }))
    .rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
  expect(asked).toEqual([]); expect(started()).toBe(0); expect(status()).toBe('pending-approval');
  // On a real terminal --yes shows the card anyway (a notice says so); the person's yes trusts the server.
  // Each card is answered once it listens (its key hints replace the first frame's "…").
  const cards = [{ when: 'to read its tools?', send: '' }, { when: 'Esc cancel', send: 'y' }, { when: 'and pin these tools?', send: '' }, { when: 'Esc cancel', send: 'y' }];
  const approve = (cwd: string, ...flags: string[]) => runInTerminal([process.execPath, CLI, 'mcp', 'approve', 'fx', '--yes', ...flags], cwd, env, cards);
  const trustReceipt = { schemaVersion: 1, approved: true, name: 'fx', scope: 'project', pinnedTools: 1 };
  const approved = await approve(project, '--json');
  expect(approved.code, approved.output).toBe(1);
  expect(approved.output).toContain('--yes does not skip the card');
  expect(lastJson(approved.output)).toEqual({ ...trustReceipt, grant: { status: 'refused', reason: 'POLICY_UNAVAILABLE' } });
  expect(status()).toBe('trusted');
  const human = await approve(project);
  expect(human.code, human.output).toBe(1);
  expect(human.output).toContain('Trusted, but no policy grant was written: POLICY_UNAVAILABLE.');

  const governed = join(base, 'governed');
  mkdirSync(governed, { mode: 0o700 });
  const policy = await runInTerminal([process.execPath, CLI, 'init', 'policy', '--scope', 'installation', '--apply', '--json'], governed, env);
  expect(policy.code, policy.output).toBe(0);
  expect(lastJson(policy.output)).toMatchObject({ status: 'installed' });
  const registered = runAt(governed, ...addProject);
  expect(registered.code, registered.err).toBe(0);
  const granted = await approve(governed, '--json');
  expect(granted.code, granted.output).toBe(0);
  expect(lastJson(granted.output)).toEqual({ ...trustReceipt, grant: { status: 'granted' } });
  const saved = runAt(governed, 'get', 'fx', '--json');
  expect(saved.code, saved.err).toBe(0);
  expect(JSON.parse(saved.out)).toMatchObject({ server: { grant: { status: 'granted', scopes: ['installation'] } } });
}, 120_000);
