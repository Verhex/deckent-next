import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { mcpProjectTrustDirectory } from '#adapters/core/mcp-trust/index.js';
import { runConfiguredMcpCommand } from '#composition/core/agent-turn/index.js';
import { clearConfigCache } from '#platform/index.js';
import { lastJson, runInTerminal } from '../support/terminal-cli.js';

// MCP-CLIENT: the compiled `deckent mcp` commands as a real process over a real project (add → list → approve → list → remove), with a
// real SDK server whose own log shows when it was started.
const CLI = resolve('dist/composition/core/cli/internal/entry.js'), FIXTURE = resolve('tests/fixtures/mcp-stdio-server.mjs');
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

// C-MODELS (owner A48-D5/D6): trust is a person's card on a terminal; off a terminal the compiled CLI refuses it, `--yes` included, before anything starts
// or is written. SEC-1 (J2e join): two layers, each pinned here — the CLI refuses first (MCP_APPROVAL_NEEDS_TERMINAL); the application behind it
// keeps the witness as the backstop (AUTHORITY_WITNESS_REQUIRED for any non-TTY caller). The trusted half is the compiled CLI on a real PTY, cards answered.
it.skipIf(process.platform !== 'linux')('add, list, approve, get and remove through the compiled CLI; approval without a terminal is refused, --yes included', async () => {
  const base = mkdtempSync(join(tmpdir(), 'deckent-mcp-cli-')); roots.push(base);
  const project = join(base, 'project'), home = join(base, 'home'), tools = join(base, 'tools.json'), log = join(base, 'log.jsonl');
  mkdirSync(join(project, '.deckent'), { recursive: true }); mkdirSync(home, { mode: 0o700 });
  writeFileSync(join(project, '.deckent', 'config.json'), '{}\n'); appendFileSync(log, '');
  writeFileSync(tools, JSON.stringify([{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: {} } }]));
  const env = { HOME: home, PATH: process.env['PATH'] ?? '/usr/bin:/bin', DECKENT_LANGUAGE: 'en' };
  const agentEnv = { ...env, AI_AGENT: '1' };
  const runCli = (cwd: string, childEnv: NodeJS.ProcessEnv, ...argv: string[]) => {
    const result = spawnSync(process.execPath, [CLI, ...argv], { cwd, env: childEnv, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
    return { code: result.status, out: result.stdout, err: result.stderr };
  };
  const runAt = (cwd: string, ...argv: string[]) => runCli(cwd, env, 'mcp', ...argv);
  const runAsAgent = (cwd: string, ...argv: string[]) => runCli(cwd, agentEnv, 'mcp', ...argv);
  const run = (...argv: string[]) => runAt(project, ...argv);
  const json = (result: ReturnType<typeof run>) => { expect(result.code, result.err).toBe(0); return JSON.parse(result.out) as Record<string, unknown>; };
  const started = () => readFileSync(log, 'utf8').split('\n').filter(line => line.includes('"start"')).length;
  const launch = ['--', process.execPath, FIXTURE, '--mode', 'legacy', '--tools', tools, '--log', log];
  const addProject = ['add', '--scope', 'project', '--realm', 'host', 'fx', '--json', ...launch];
  const addPersonal = ['add', '--realm', 'host', 'lx', '--json', ...launch];
  expect(json(run(...addProject))).toMatchObject({ added: { name: 'fx', scope: 'project', file: join(project, '.deckent', 'mcp.json') }, trust: 'pending' });
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
  const cards = [
    { when: 'to read its tools?', send: '' }, { when: 'Esc cancel', send: 'y' }, { when: 'and pin these tools?', send: '' }, { when: 'Esc cancel', send: 'y' }];
  // The backstop layer: the application refuses a caller without a terminal even with its card answered yes; nothing is started.
  await expect(runConfiguredMcpCommand(project, { verb: 'approve', name: 'fx' }, { env }, async () => true)).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
  expect(started()).toBe(0);
  const refusedGrant = { status: 'refused', reason: 'POLICY_UNAVAILABLE' };
  const trustReceipt = { schemaVersion: 1, approved: true, name: 'fx', scope: 'project', pinnedTools: 1 };
  const approved = await runInTerminal([process.execPath, CLI, 'mcp', 'approve', 'fx', '--json'], project, env, cards);
  expect(approved.code, approved.output).toBe(1);
  expect(lastJson(approved.output)).toEqual({ ...trustReceipt, grant: refusedGrant });
  const startedAfterCard = started();
  expect(json(run('list', '--json'))).toMatchObject({ servers: [{ name: 'fx', status: 'trusted', health: 'not-started' }] });
  expect(started()).toBe(startedAfterCard);
  expect(json(run('list', '--check', '--json'))).toMatchObject({ servers: [{ name: 'fx', status: 'trusted', health: 'connected', era: 'legacy' }] });
  expect(json(run('get', 'fx', '--json'))).toMatchObject({ server: { name: 'fx', trust: { tools: [{ name: 'echo' }] } } });
  const human = await runInTerminal([process.execPath, CLI, 'mcp', 'approve', 'fx'], project, env, cards);
  expect(human.code, human.output).toBe(1);
  expect(human.output).toContain('Trusted, but no policy grant was written: POLICY_UNAVAILABLE.');
  const removed = run('remove', 'fx', '--json');
  expect.soft(removed.code, removed.err).toBe(0);
  expect.soft(JSON.parse(removed.out)).toEqual({ schemaVersion: 1, removed: { name: 'fx', scope: 'project', file: join(project, '.deckent', 'mcp.json') } });
  // A personal add is its trust decision: without a terminal it is refused, --yes included (nothing is written before).
  for (const extra of [[], ['--yes']]) {
    const personal = run('add', ...extra, '--realm', 'host', 'lx', '--', process.execPath, FIXTURE, '--mode', 'legacy', '--tools', tools, '--log', log);
    expect(personal.code).toBe(2); expect(personal.err + personal.out).toContain('MCP_APPROVAL_NEEDS_TERMINAL');
  }
  expect(existsSync(join(home, '.deckent', 'mcp.json'))).toBe(false);
  clearConfigCache();
  const entry = { command: process.execPath, args: [FIXTURE, '--mode', 'legacy', '--tools', tools, '--log', log], realm: 'host' };
  await expect(runConfiguredMcpCommand(project, { verb: 'add', scope: 'local', name: 'lx', approve: true, entry }, { env }, async () => true))
    .rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
  expect(existsSync(join(home, '.deckent', 'mcp.json'))).toBe(false);
  const added = await runInTerminal([process.execPath, CLI, 'mcp', ...addPersonal], project, env, cards);
  expect(added.code, added.output).toBe(1);
  expect(lastJson(added.output)).toMatchObject({ added: { name: 'lx', scope: 'local' }, trust: 'trusted', pinnedTools: 1, grant: refusedGrant });
  const gone = run('get', 'fx');
  expect(gone.code).not.toBe(0); expect(gone.err + gone.out).toContain('MCP_SERVER_UNKNOWN');
  // SEC-2 (F29): local and project trust live in the global root's directory of this project, never in the project tree.
  expect(existsSync(join(project, '.deckent', 'integrations', 'mcp-trust.json'))).toBe(false);
  expect(JSON.parse(readFileSync(join(await mcpProjectTrustDirectory(project, join(home, '.deckent'), false), 'mcp-trust.json'), 'utf8')))
    .toMatchObject({ servers: [{ name: 'lx', scope: 'local', decision: 'trusted' }] });
  const policyAbsent = runCli(project, agentEnv, 'policy', 'mcp', 'list');
  expect(policyAbsent.err + policyAbsent.out).toContain('CLI_INSTALLATION_MISSING');
  const revokedWithoutPolicy = await runInTerminal([process.execPath, CLI, 'mcp', 'revoke', 'lx', '--json'], project, env);
  expect.soft(revokedWithoutPolicy.code, revokedWithoutPolicy.output).toBe(0);
  expect.soft(lastJson(revokedWithoutPolicy.output)).toEqual({ schemaVersion: 1, revoked: { name: 'lx', scope: 'local' } });
  const agentWithoutPolicy = runAsAgent(project, 'revoke', 'lx', '--lang', 'tr');
  expect.soft(agentWithoutPolicy.code, agentWithoutPolicy.err).toBe(0);
  expect.soft(agentWithoutPolicy.out.trimEnd()).toBe('lx için güven geri alındı. Sunucuyu başlatmadan önce yeniden onaylayın.');

  const governed = join(base, 'governed');
  mkdirSync(governed, { mode: 0o700 });
  const policy = await runInTerminal([process.execPath, CLI, 'init', 'policy', '--scope', 'installation', '--apply', '--json'], governed, env);
  expect(policy.code, policy.output).toBe(0);
  expect(lastJson(policy.output)).toMatchObject({ status: 'installed' });
  expect(json(runAt(governed, ...addProject))).toMatchObject({ added: { name: 'fx', scope: 'project' }, trust: 'pending' });
  const agentNoGrant = runAsAgent(governed, 'get', 'fx', '--json');
  expect(json(agentNoGrant)).toMatchObject({ server: { grant: { status: 'none' } } });
  const agentRevoked = runAsAgent(governed, 'revoke', 'fx', '--lang', 'en');
  expect.soft(agentRevoked.code, agentRevoked.err).toBe(0);
  expect.soft(agentRevoked.out.trimEnd()).toBe('Trust for fx was revoked. Approve it again before starting the server.');
  const witnessedRevoked = await runInTerminal([process.execPath, CLI, 'mcp', 'revoke', 'fx', '--json'], governed, env);
  expect(witnessedRevoked.code, witnessedRevoked.output).toBe(0);
  expect(lastJson(witnessedRevoked.output)).toEqual({ schemaVersion: 1, revoked: { name: 'fx', scope: 'project' } });
  expect(json(runAt(governed, 'remove', 'fx', '--json'))).toEqual({
    schemaVersion: 1, removed: { name: 'fx', scope: 'project', file: join(governed, '.deckent', 'mcp.json') },
  });
  expect(json(runAt(governed, ...addProject))).toMatchObject({ added: { name: 'fx', scope: 'project' }, trust: 'pending' });
  const granted = await runInTerminal([process.execPath, CLI, 'mcp', 'approve', 'fx', '--json'], governed, env, cards);
  expect(granted.code, granted.output).toBe(0);
  expect(lastJson(granted.output)).toEqual({ ...trustReceipt, grant: { status: 'granted' } });
  expect(json(runAt(governed, 'get', 'fx', '--json'))).toMatchObject({ server: { grant: { status: 'granted', scopes: ['installation'] } } });
  const addedAndGranted = await runInTerminal([process.execPath, CLI, 'mcp', ...addPersonal], governed, env, cards);
  expect(addedAndGranted.code, addedAndGranted.output).toBe(0);
  expect(lastJson(addedAndGranted.output)).toMatchObject({ added: { name: 'lx', scope: 'local' }, trust: 'trusted', pinnedTools: 1, grant: { status: 'granted' } });
  const agentWithGrant = runAsAgent(governed, 'revoke', 'lx', '--lang', 'en');
  expect(agentWithGrant.code, agentWithGrant.err).toBe(1);
  expect(agentWithGrant.out.trimEnd()).toBe("Trust for lx was revoked. Approve it again before starting the server.\nThis operation removed no policy grant. Removing one needs the grant owner's terminal.");
  expect(json(runAsAgent(governed, 'get', 'lx', '--json'))).toMatchObject({
    server: { status: 'pending-approval', trust: null, grant: { status: 'granted', scopes: ['installation'] } },
  });
  const bindings = join(governed, '.deckent', 'bindings.json'), savedBindings = readFileSync(bindings);
  writeFileSync(bindings, '{');
  try {
    const unreadable = runAt(governed, 'revoke', 'lx', '--json');
    expect(unreadable.code, unreadable.err).toBe(1);
    expect(JSON.parse(unreadable.out)).toEqual({
      schemaVersion: 1, revoked: { name: 'lx', scope: 'local' }, grant: { status: 'refused', reason: 'AUTHORITY_WITNESS_REQUIRED' },
    });
  } finally {
    writeFileSync(bindings, savedBindings);
  }
  expect(json(runAt(governed, 'get', 'lx', '--json'))).toMatchObject({ server: { grant: { status: 'granted', scopes: ['installation'] } } });
  const removedAndRevoked = await runInTerminal([process.execPath, CLI, 'mcp', 'remove', 'fx', '--json'], governed, env);
  expect(removedAndRevoked.code, removedAndRevoked.output).toBe(0);
  expect(lastJson(removedAndRevoked.output)).toMatchObject({ removed: { name: 'fx', scope: 'project' }, grant: { status: 'revoked' } });
}, 120_000);
