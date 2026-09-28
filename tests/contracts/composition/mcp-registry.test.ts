import { createHash } from 'node:crypto';
import { existsSync, appendFileSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildLandlockRules, createShellPathContext, createWorkspaceReadTools, createWorkspaceScope, loadMcpRegistry, mcpClientSettings, McpClientPool, mcpTurnTools,
  openMcpAgentTools, probeShellCapabilities } from '#adapters/index.js';
import { bubblewrapShellSandbox, resolveBubblewrapView } from '#adapters/core/shell-sandbox-bwrap/index.js';
import { classifyReadOnlyShellCommand } from '#engine/index.js';
import { agentWorkspaceDeny, runConfiguredMcpCommand } from '#composition/core/agent-turn/index.js';
import { clearConfigCache, resolveProductLayout } from '#platform/index.js';
import { mcpCommand } from '#surfaces/core/cli/index.js';

// MCP-CLIENT registry (owner 2026-09-28): servers live in scoped files outside configuration — project `.deckent/mcp.json`, personal
// `<global root>/mcp.json` (user at the top, local under `projects.<real path>`) — trust and tool pins in product state. Real SDK server
// processes; each fixture's own log shows which definition was started.
const FIXTURE = resolve('tests/fixtures/mcp-stdio-server.mjs');
const capabilities = await probeShellCapabilities();
const sandboxReady = capabilities.bubblewrap === 'available' && capabilities.userNamespace === 'available' && existsSync('/usr/bin/bwrap');
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function workspace() {
  const base = mkdtempSync(join(tmpdir(), 'deckent-mcp-registry-')); roots.push(base);
  const project = join(base, 'project'), home = join(base, 'home');
  mkdirSync(join(project, '.deckent'), { recursive: true }); mkdirSync(home, { mode: 0o700 });
  writeFileSync(join(project, '.deckent', 'config.json'), '{}\n');
  const env = { HOME: home, PATH: process.env['PATH'] ?? '/usr/bin:/bin', MY_TOKEN: 's3cr3t-value-xyz' };
  const tools = join(base, 'tools.json');
  writeFileSync(tools, JSON.stringify([{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: {} } }]));
  const server = (label: string) => {
    const log = join(base, `${label}.jsonl`); appendFileSync(log, '');
    return { args: ['--realm', 'host', '--', process.execPath, FIXTURE, '--mode', 'dual', '--tools', tools, '--log', log],
      started: () => readFileSync(log, 'utf8').split('\n').filter(line => line.includes('"start"')).length,
      calls: () => readFileSync(log, 'utf8').split('\n').filter(line => line.includes('"call"')).length };
  };
  const out: string[] = [];
  const cli = async (...argv: string[]) => {
    out.length = 0;
    const at = argv.indexOf('--'), full = at < 0 ? [...argv, '--json'] : [...argv.slice(0, at), '--json', ...argv.slice(at)];
    await mcpCommand(['mcp', ...full], { root: project, env, stdout: { write: (text: string) => { out.push(text); return true; } }, runMcpCommand: runConfiguredMcpCommand });
    return JSON.parse(out.join('')) as Record<string, unknown>;
  };
  return { base, project, home, env, server, cli };
}
const byName = (listed: Record<string, unknown>) => Object.fromEntries((listed['servers'] as { name: string }[]).map(server => [server.name, server as Record<string, unknown>]));

describe.skipIf(process.platform !== 'linux')('MCP registry: scopes, precedence and approval (real processes)', () => {
  it('the same name in local, project and user starts only the local definition; removing it falls back to project, which needs its own approval', async () => {
    const w = workspace(), local = w.server('local'), project = w.server('project'), user = w.server('user');
    await w.cli('add', '--scope', 'user', 'fx', ...user.args);
    await w.cli('add', '--scope', 'project', 'fx', ...project.args);
    await w.cli('add', 'fx', ...local.args);
    expect(statSync(join(w.home, '.deckent', 'mcp.json')).mode & 0o777).toBe(0o600);
    expect(byName(await w.cli('list'))['fx']).toMatchObject({ scope: 'local', status: 'pending-approval', health: 'not-started', shadows: ['project', 'user'] });
    expect([local.started(), project.started(), user.started()]).toEqual([0, 0, 0]);
    expect(await w.cli('approve', 'fx', '--yes')).toMatchObject({ approved: true, scope: 'local', pinnedTools: 1 });
    expect(byName(await w.cli('list'))['fx']).toMatchObject({ scope: 'local', status: 'trusted', health: 'connected', era: 'modern' });
    expect(local.started()).toBeGreaterThan(0); expect([project.started(), user.started()]).toEqual([0, 0]);
    await expect(w.cli('remove', 'fx')).rejects.toMatchObject({ code: 'MCP_SERVER_SCOPE_AMBIGUOUS' });
    expect(await w.cli('remove', 'fx', '--scope', 'local')).toMatchObject({ removed: { scope: 'local' } });
    expect((await w.cli('get', 'fx'))['server']).toMatchObject({ scope: 'project', status: 'pending-approval', shadows: ['user'] });
    await w.cli('list');
    expect(project.started()).toBe(0);
    await w.cli('approve', 'fx', '--yes');
    expect(project.started()).toBeGreaterThan(0); expect(user.started()).toBe(0);
    expect([local.calls(), project.calls(), user.calls()]).toEqual([0, 0, 0]);
  }, 90_000);

  it('approval lives in product state, never in the registry file; an entry that claims trust is invalid; a changed entry asks again', async () => {
    const w = workspace(), fx = w.server('fx');
    await w.cli('add-json', '--scope', 'project', 'fx', JSON.stringify({ command: process.execPath, args: fx.args.slice(4), realm: 'host' }));
    const file = join(w.project, '.deckent', 'mcp.json'), digest = () => createHash('sha256').update(readFileSync(file)).digest('hex'), before = digest();
    await w.cli('approve', 'fx', '--yes');
    expect(digest()).toBe(before);
    const trust = join(w.project, '.deckent', 'integrations', 'mcp-trust.json');
    expect(statSync(trust).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(trust, 'utf8'))).toMatchObject({ schemaVersion: 1, servers: [{ scope: 'project', name: 'fx', tools: [{ name: 'echo' }] }] });
    expect(byName(await w.cli('list'))['fx']).toMatchObject({ status: 'trusted' });
    // A committed file cannot approve itself.
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers: Record<string, Record<string, unknown>> };
    writeFileSync(file, JSON.stringify({ mcpServers: { ...raw.mcpServers, sneaky: { ...raw.mcpServers['fx'], trusted: true } } }));
    const listed = await w.cli('list');
    expect(byName(listed)['sneaky']).toBeUndefined();
    expect(listed['problems']).toEqual([expect.objectContaining({ name: 'sneaky', scope: 'project', reason: 'invalid-entry' })]);
    // Any change of the approved entry (here one argument) asks again: nothing starts until approved.
    writeFileSync(file, JSON.stringify({ mcpServers: { fx: { ...raw.mcpServers['fx'], args: [...(raw.mcpServers['fx']!['args'] as string[]), '--token', 'changed'] } } }));
    const started = fx.started();
    expect(byName(await w.cli('list'))['fx']).toMatchObject({ status: 'changed', health: 'not-started' });
    expect(fx.started()).toBe(started);
    await w.cli('approve', 'fx', '--yes');
    expect(byName(await w.cli('list'))['fx']).toMatchObject({ status: 'trusted', health: 'connected' });
    expect(fx.started()).toBeGreaterThan(started);
  }, 60_000);

  it('an expanded ${VAR} (a personal token in args) never shows on the approval card or the tool-call card; the definition stays the template', async () => {
    const w = workspace(), fx = w.server('fx');
    await w.cli('add', 'fx', ...fx.args, '--token', '${MY_TOKEN}');
    const approved = await (async () => { const out: string[] = []; await mcpCommand(['mcp', 'approve', 'fx', '--yes', '--json'], { root: w.project, env: w.env,
      stdout: { write: (text: string) => { out.push(text); return true; } }, runMcpCommand: async (root, request, options, confirm) =>
        runConfiguredMcpCommand(root, request as never, options, async card => { out.push(JSON.stringify(card)); return confirm(card); }) }); return out.join(''); })();
    expect(approved).toContain('${MY_TOKEN}'); expect(approved).toContain('"name":"MY_TOKEN","set":true'); expect(approved).not.toContain('s3cr3t-value-xyz');
    const view = await loadMcpRegistry({ projectRoot: w.project, layout: resolveProductLayout({ projectRoot: w.project }), environment: w.env, secret: async () => undefined });
    const settings = mcpClientSettings(view, {})!;
    expect(settings.servers[0]!.args).toContain('s3cr3t-value-xyz');
    const controller = new AbortController(), pool = new McpClientPool(controller.signal);
    try {
      const tools = mcpTurnTools(await openMcpAgentTools(pool, settings, { cwd: w.project, environment: w.env, sandboxes: [] }));
      const preview = tools.preview('mcp__fx__echo', {});
      expect(preview).toContain('${MY_TOKEN}'); expect(preview).not.toContain('s3cr3t-value-xyz');
    } finally { controller.abort(); await pool.close(); }
  }, 60_000);
});

describe('the agent cannot reach the project MCP registry (read floor, shell, both sandboxes)', () => {
  const setup = async () => {
    const w = workspace();
    writeFileSync(join(w.project, '.deckent', 'mcp.json'), '{"mcpServers":{"fx":{"command":"REGISTRY-SECRET"}}}\n');
    writeFileSync(join(w.project, '.deckent', '.mcp.json.4242.abcd.tmp'), 'REGISTRY-SECRET\n');
    mkdirSync(join(w.project, 'src')); writeFileSync(join(w.project, 'src', 'a.ts'), 'export const a = 1;\n');
    const deny = agentWorkspaceDeny(w.project, resolveProductLayout({ projectRoot: w.project, root: join(w.base, 'data') }));
    return { ...w, deny, scope: await createWorkspaceScope(w.project, deny) };
  };
  it('read tools refuse it, list and grep do not show it, the shell classifies it protected; the configuration stays readable', async () => {
    const p = await setup(), tools = await createWorkspaceReadTools(p.project, { deny: p.deny });
    expect((await tools.execute('read_file', { path: '.deckent/mcp.json' })).text).toContain('error=path-denied');
    expect((await tools.execute('read_file', { path: '.deckent/.mcp.json.4242.abcd.tmp' })).text).toContain('error=path-denied');
    expect((await tools.execute('list_dir', { path: '.deckent' })).text).not.toContain('mcp.json');
    expect((await tools.execute('grep', { pattern: 'REGISTRY-SECRET', path: '.deckent' })).text).not.toContain('REGISTRY-SECRET"');
    expect((await tools.execute('read_file', { path: '.deckent/config.json' })).text).toContain('{}');
    expect(await classifyReadOnlyShellCommand('cat .deckent/mcp.json', createShellPathContext(p.scope))).toMatchObject({ readOnly: false, reasonCode: 'PATH_PROTECTED' });
  });
  it('the bubblewrap view masks it and Landlock gives it no rule', async () => {
    const p = await setup();
    const view = await resolveBubblewrapView({ project: p.scope, scratchDir: null }, { PATH: '/usr/bin:/bin' });
    expect(view.ok).toBe(true); if (!view.ok) return;
    expect(view.view.maskedFiles).toContain(join(p.scope.root, '.deckent', 'mcp.json'));
    const built = await buildLandlockRules({ project: p.scope, scratchDir: null });
    expect(built.ok).toBe(true); if (!built.ok) return;
    const ruled = built.rules.map(([, path]) => path);
    expect(ruled).not.toContain('.deckent/mcp.json'); expect(ruled).toContain('.deckent/config.json');
  });
  it.skipIf(!sandboxReady)('a real bubblewrap shell can neither read nor replace it', async () => {
    const p = await setup();
    const usable = bubblewrapShellSandbox({ project: p.scope, scratchDir: null }).usable(capabilities);
    expect(usable.ok).toBe(true); if (!usable.ok) return;
    const result = await usable.realm.run({ command: 'cat .deckent/mcp.json; echo \'{"mcpServers":{}}\' > .deckent/mcp.json; cat src/a.ts; true',
      cwd: p.scope.root, environment: { PATH: '/usr/bin:/bin', HOME: p.home }, fixedEnv: {}, timeoutMs: 20_000 });
    expect(result.output).not.toContain('REGISTRY-SECRET'); expect(result.output).toContain('export const a = 1;');
    expect(readFileSync(join(p.project, '.deckent', 'mcp.json'), 'utf8')).toContain('REGISTRY-SECRET');
  });
});
