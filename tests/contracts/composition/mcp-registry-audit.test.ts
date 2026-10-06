import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMcpCommand, type McpCommandContext, type McpCommandRequest } from '#adapters/core/mcp-client/index.js';
import { clearConfigCache, loadConfig } from '#platform/index.js';

// MCP-REGISTRY-AUDIT (top-20 #5, 2026-10-06): the registry file is written only after the audited trust decision. `add` and `remove` used to write the
// file first, so an audit failure left an entry (or a removal) with no audit event, and a project add recorded nothing at all.
const FIXTURE = resolve('tests/fixtures/mcp-stdio-server.mjs');
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function workspace() {
  const base = mkdtempSync(join(tmpdir(), 'deckent-mcp-audit-')); roots.push(base);
  const project = join(base, 'project'), home = join(base, 'home');
  mkdirSync(join(project, '.deckent'), { recursive: true }); mkdirSync(home, { mode: 0o700 });
  writeFileSync(join(project, '.deckent', 'config.json'), '{}\n');
  const env = { HOME: home, USERPROFILE: home, PATH: process.env['PATH'] ?? '/usr/bin:/bin' };
  const tools = join(base, 'tools.json'), log = join(base, 'fx.jsonl'); appendFileSync(log, '');
  writeFileSync(tools, JSON.stringify([{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: {} } }]));
  const entry = { command: process.execPath, args: [FIXTURE, '--mode', 'dual', '--tools', tools, '--log', log], realm: 'host' };
  const layout = (await loadConfig(project, { env })).productLayout;
  const audits: { action: string; scope: string; name: string }[] = [];
  const asked: string[] = [];
  const state = { failAudit: false };
  const context: McpCommandContext = { projectRoot: project, layout, environment: env, secret: async () => undefined, sandboxes: [],
    principal: { issuer: 'test', subject: 'owner' }, describeNotice: notice => JSON.stringify(notice),
    ask: async card => { asked.push(`${card.phase}:${card.name}`); return true; },
    audit: async change => { if (state.failAudit) throw new Error('audit refused'); audits.push({ action: change.action, scope: change.scope, name: change.name }); } };
  const run = (request: McpCommandRequest) => runMcpCommand(request, context);
  const files = { project: join(project, '.deckent', 'mcp.json'), personal: join(home, '.deckent', 'mcp.json'),
    projectTrust: join(project, '.deckent', 'integrations', 'mcp-trust.json'), userTrust: join(home, '.deckent', 'mcp-trust.json') };
  const read = (path: string) => existsSync(path) ? readFileSync(path, 'utf8') : null;
  return { run, entry, audits, asked, state, files, read };
}

describe.skipIf(process.platform !== 'linux')('MCP registry writes follow the audited trust decision', () => {
  it('a failing audit leaves the registry and the trust record untouched on add (personal and project scope)', async () => {
    const w = await workspace();
    w.state.failAudit = true;
    await expect(w.run({ verb: 'add', scope: 'user', name: 'fx', entry: w.entry })).rejects.toThrow('audit refused');
    await expect(w.run({ verb: 'add', scope: 'project', name: 'px', entry: w.entry })).rejects.toThrow('audit refused');
    await expect(w.run({ verb: 'add', scope: 'local', name: 'lx', entry: w.entry, approve: false })).rejects.toThrow('audit refused');
    expect(w.read(w.files.personal)).toBeNull(); expect(w.read(w.files.project)).toBeNull();
    expect(w.read(w.files.userTrust)).toBeNull(); expect(w.read(w.files.projectTrust)).toBeNull();
    expect(w.audits).toEqual([]);
  }, 60_000);

  it('a failing audit leaves the registry bytes and the trust bytes unchanged on remove', async () => {
    const w = await workspace();
    await w.run({ verb: 'add', scope: 'user', name: 'fx', entry: w.entry });
    const registry = w.read(w.files.personal), trust = w.read(w.files.userTrust);
    expect(registry).toContain('"fx"'); expect(trust).toContain('"trusted"');
    w.state.failAudit = true;
    await expect(w.run({ verb: 'remove', name: 'fx' })).rejects.toThrow('audit refused');
    expect(w.read(w.files.personal)).toBe(registry); expect(w.read(w.files.userTrust)).toBe(trust);
  }, 60_000);

  it('a project add is audited (reset of any earlier decision) and records no trust; the audit comes before the file', async () => {
    const w = await workspace();
    expect(await w.run({ verb: 'add', scope: 'project', name: 'px', entry: w.entry })).toMatchObject({ trust: 'pending' });
    expect(w.audits).toEqual([{ action: 'reset', scope: 'project', name: 'px' }]);
    expect(w.read(w.files.project)).toContain('"px"');
    expect(w.asked).toEqual([]);
  }, 60_000);

  it('remove is audited as revoke; the same definition added again asks the trust cards again', async () => {
    const w = await workspace();
    await w.run({ verb: 'add', scope: 'user', name: 'fx', entry: w.entry });
    expect(w.asked).toEqual(['launch:fx', 'tools:fx']);
    await w.run({ verb: 'remove', name: 'fx' });
    expect(w.audits.map(audit => audit.action)).toEqual(['trust', 'revoke']);
    expect(JSON.parse(w.read(w.files.userTrust)!).servers).toEqual([]);
    expect(JSON.parse(w.read(w.files.personal)!).mcpServers).toEqual({});
    w.asked.length = 0;
    expect(await w.run({ verb: 'add', scope: 'user', name: 'fx', entry: w.entry })).toMatchObject({ trust: 'trusted' });
    expect(w.asked).toEqual(['launch:fx', 'tools:fx']);
  }, 60_000);

  it('a declined card still writes the entry, audited as decline; an existing name is refused before any card or audit', async () => {
    const w = await workspace();
    const refuse = { ...w, run: w.run };
    expect(await refuse.run({ verb: 'add', scope: 'user', name: 'fx', entry: w.entry, approve: false })).toMatchObject({ trust: 'pending' });
    w.audits.length = 0;
    await expect(w.run({ verb: 'add', scope: 'user', name: 'fx', entry: w.entry })).rejects.toMatchObject({ code: 'MCP_SERVER_EXISTS' });
    expect(w.asked).toEqual([]); expect(w.audits).toEqual([]);
  }, 60_000);
});
