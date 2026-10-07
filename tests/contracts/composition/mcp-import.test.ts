import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mcpImportEntry, readMcpImportSources } from '#adapters/index.js';
import { runConfiguredMcpCommand } from '#composition/core/agent-turn/index.js';
import { clearConfigCache } from '#platform/index.js';
import { mcpCommand, type CommandContext } from '#surfaces/core/cli/index.js';

// L1 MCP-CORE item 2 (TUI3 2026-10-07): `deckent mcp import` reads the servers Claude Code (`.mcp.json`, `~/.claude.json` user and local) and Claude
// Desktop (macOS, Windows, WSL) declare, and adds each through the registry's own `add` — untrusted: every imported server waits for its approval
// and nothing starts. Names Deckent cannot take and SSE/WebSocket entries are listed with their reason, never renamed or converted.
const FIXTURE = resolve('tests/fixtures/mcp-stdio-server.mjs');
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function workspace() {
  const base = mkdtempSync(join(tmpdir(), 'deckent-mcp-import-')); roots.push(base);
  const project = join(base, 'project'), home = join(base, 'home');
  mkdirSync(join(project, '.deckent'), { recursive: true }); mkdirSync(home, { mode: 0o700 });
  writeFileSync(join(project, '.deckent', 'config.json'), '{}\n');
  const env = { HOME: home, USERPROFILE: home, PATH: process.env['PATH'] ?? '/usr/bin:/bin' };
  const log = join(base, 'started.jsonl'), tools = join(base, 'tools.json'); appendFileSync(log, '');
  writeFileSync(tools, JSON.stringify([{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: {} } }]));
  const stdio = { command: process.execPath, args: [FIXTURE, '--mode', 'dual', '--tools', tools, '--log', log] };
  const started = () => readFileSync(log, 'utf8').split('\n').filter(line => line.includes('"start"')).length;
  const run = (request: Parameters<typeof runConfiguredMcpCommand>[1]) => runConfiguredMcpCommand(project, request, { env }, async () => { throw new Error('no card may open'); }) as Promise<Record<string, unknown>>;
  return { base, project, home, env, stdio, started, run };
}

describe.skipIf(process.platform !== 'linux')('mcp import (Claude Code and Claude Desktop configurations)', () => {
  it('Claude Code: .mcp.json to project, ~/.claude.json to user and local; every server is pending and nothing starts; unusable entries are listed', async () => {
    const w = workspace();
    writeFileSync(join(w.project, '.mcp.json'), JSON.stringify({ mcpServers: { 'team-docs': { type: 'streamable-http', url: 'https://mcp.example.com/mcp' },
      legacy: { type: 'sse', url: 'https://mcp.example.com/sse' }, My_Server: { command: 'node' } } }));
    writeFileSync(join(w.home, '.claude.json'), JSON.stringify({ numStartups: 3, mcpServers: { context7: { type: 'stdio', ...w.stdio, env: { API_KEY: '${CTX_KEY}' } } },
      projects: { [w.project]: { mcpServers: { local1: { ...w.stdio, disabled: false } } }, '/elsewhere': { mcpServers: { other: { command: 'x' } } } } }));
    const result = await w.run({ verb: 'import', from: 'claude-code' });
    expect(result['imported']).toEqual(expect.arrayContaining([{ name: 'team-docs', scope: 'project', file: join(w.project, '.mcp.json') },
      { name: 'context7', scope: 'user', file: join(w.home, '.claude.json') }, { name: 'local1', scope: 'local', file: join(w.home, '.claude.json') }]));
    expect((result['imported'] as unknown[]).length).toBe(3);
    expect(result['skipped']).toEqual(expect.arrayContaining([{ name: 'legacy', file: join(w.project, '.mcp.json'), reason: 'transport-unsupported' },
      { name: 'My_Server', file: join(w.project, '.mcp.json'), reason: 'invalid-name' }]));
    const listed = await w.run({ verb: 'list', health: false }) as { servers: { name: string; status: string; transport: string }[] };
    expect(listed.servers.map(server => [server.name, server.status, server.transport]).sort()).toEqual([['context7', 'pending-approval', 'stdio'],
      ['local1', 'pending-approval', 'stdio'], ['team-docs', 'pending-approval', 'http']]);
    expect(w.started()).toBe(0);
    // The registry holds the imported definition (Deckent's shape: the alias becomes `http`, client-specific keys are not carried).
    expect(JSON.parse(readFileSync(join(w.project, '.deckent', 'mcp.json'), 'utf8'))).toEqual({ mcpServers: { 'team-docs': { type: 'http', url: 'https://mcp.example.com/mcp' } } });
    // A second import changes nothing and says why.
    const again = await w.run({ verb: 'import', from: 'claude-code' });
    expect(again['imported']).toEqual([]);
    expect((again['skipped'] as { reason: string }[]).filter(entry => entry.reason === 'MCP_SERVER_EXISTS')).toHaveLength(3);
  }, 60_000);

  it('an explicit file imports to local or user (never the shared project file); a missing Claude configuration is not an error', async () => {
    const w = workspace(), file = join(w.base, 'desktop.json');
    writeFileSync(file, JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'], env: { BRAVE_API_KEY: 'literal' } } } }));
    expect(await w.run({ verb: 'import', from: { file }, scope: 'user' })).toMatchObject({ imported: [{ name: 'fs', scope: 'user' }], skipped: [] });
    expect(JSON.stringify(await w.run({ verb: 'get', name: 'fs' }))).not.toContain('literal');
    expect(await w.run({ verb: 'import', from: 'claude-code' })).toEqual({ schemaVersion: 1, imported: [], skipped: [] });
    expect(existsSync(join(w.project, '.deckent', 'mcp.json'))).toBe(false);
  }, 60_000);
});

describe('Claude Desktop sources and the entry conversion (pure over a temp tree)', () => {
  it('under WSL the single Windows profile with a Claude Desktop config is read; several profiles or none are named problems; native Linux has none', async () => {
    const base = mkdtempSync(join(tmpdir(), 'deckent-mcp-desktop-')); roots.push(base);
    const profile = (user: string) => { const dir = join(base, user, 'AppData', 'Roaming', 'Claude'); mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'claude_desktop_config.json'), JSON.stringify({ mcpServers: { [`${user.toLowerCase()}-fs`]: { command: 'npx' } } })); };
    mkdirSync(join(base, 'Public')); profile('Alice');
    const read = (extra: Partial<Parameters<typeof readMcpImportSources>[0]> = {}) => readMcpImportSources({ projectRoot: base, projectKeys: [base], from: 'claude-desktop', environment: {},
      platform: 'linux', windowsProfiles: base, wsl: true, ...extra });
    expect(await read()).toEqual({ sources: [{ file: join(base, 'Alice', 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'), scope: 'local',
      servers: { 'alice-fs': { command: 'npx' } } }], problems: [] });
    expect((await read({ scope: 'user' })).sources[0]).toMatchObject({ scope: 'user' });
    profile('Bob');
    expect(await read()).toEqual({ sources: [], problems: [{ file: 'claude_desktop_config.json', reason: 'claude-desktop-several-profiles' }] });
    expect(await read({ wsl: false })).toEqual({ sources: [], problems: [{ file: 'claude_desktop_config.json', reason: 'claude-desktop-not-on-this-platform' }] });
    expect(await read({ platform: 'darwin', environment: { HOME: base } })).toEqual({ sources: [], problems: [] });
  });
  it('converts stdio and http (the streamable-http alias included); SSE/WebSocket and unknown types are refused by name; extra client keys are dropped', () => {
    expect(mcpImportEntry({ command: 'npx', args: ['-y', 'pkg'], env: { A: 'b' }, alwaysAllow: ['x'] })).toEqual({ ok: true, entry: { command: 'npx', args: ['-y', 'pkg'], env: { A: 'b' } } });
    expect(mcpImportEntry({ type: 'streamable-http', url: 'https://x/mcp', headers: { Authorization: 'Bearer ${T}' } }))
      .toEqual({ ok: true, entry: { type: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer ${T}' } } });
    expect(mcpImportEntry({ type: 'sse', url: 'https://x/sse' })).toEqual({ ok: false, reason: 'transport-unsupported' });
    expect(mcpImportEntry({ type: 'ws', url: 'wss://x' })).toEqual({ ok: false, reason: 'transport-unsupported' });
    expect(mcpImportEntry({ args: ['no-command'] })).toEqual({ ok: false, reason: 'invalid-entry' });
    expect(mcpImportEntry('npx')).toEqual({ ok: false, reason: 'invalid-entry' });
  });
  it('the CLI: import reads Claude Code by default; --from names Desktop or a file; --scope project or a scope for Claude Code is a usage error', async () => {
    const seen: unknown[] = [], context = { root: '/p', env: {}, stdout: { write: () => true }, runMcpCommand: async (_root: string, request: unknown) => { seen.push(request); return {}; } } as unknown as CommandContext;
    await mcpCommand(['mcp', 'import'], context);
    await mcpCommand(['mcp', 'import', '--from', 'claude-desktop', '--scope', 'user'], context);
    await mcpCommand(['mcp', 'import', '--from', '/tmp/x.json'], context);
    expect(seen).toEqual([{ verb: 'import', from: 'claude-code' }, { verb: 'import', from: 'claude-desktop', scope: 'user' }, { verb: 'import', from: { file: '/tmp/x.json' } }]);
    await expect(mcpCommand(['mcp', 'import', '--from', 'claude-desktop', '--scope', 'project'], context)).rejects.toMatchObject({ code: 'CLI_USAGE' });
    await expect(mcpCommand(['mcp', 'import', '--scope', 'user'], context)).rejects.toMatchObject({ code: 'CLI_USAGE' });
    await expect(mcpCommand(['mcp', 'import', 'extra'], context)).rejects.toMatchObject({ code: 'CLI_USAGE' });
  });
});
