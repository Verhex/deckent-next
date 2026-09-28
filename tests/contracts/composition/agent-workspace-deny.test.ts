import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildLandlockRules, createShellPathContext, createWorkspaceReadTools, createWorkspaceScope, probeShellCapabilities } from '#adapters/index.js';
import { bubblewrapShellSandbox, resolveBubblewrapView } from '#adapters/core/shell-sandbox-bwrap/index.js';
import { classifyReadOnlyShellCommand } from '#engine/index.js';
import { agentWorkspaceDeny } from '#composition/core/agent-turn/index.js';
import { resolveProductLayout } from '#platform/index.js';

const capabilities = await probeShellCapabilities();
const sandboxReady = capabilities.bubblewrap === 'available' && capabilities.userNamespace === 'available' && existsSync('/usr/bin/bwrap');
const roots: string[] = [], servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(done => server.close(() => done()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

/** Product state a live layout keeps inside the project (`.deckent/live-data`), each file carrying a sentinel no agent tool may return. */
const DATA = '.deckent/live-data';
const STATE_FILES = ['state/terminal-sessions/other-session.json', 'state/ledger.db', 'state/ledger.db-wal', 'state/terminal-history.jsonl',
  'state/terminal-history.jsonl.4242.tmp', 'state/runtime-service.log', 'state/backups/ledger-1.db', 'state/file-effects/e.json', 'policy.json',
  '.policy.json.0f0f.tmp', 'bindings.json', 'audit/events.jsonl', 'approvals/authority.key', 'workspaces/run-1/src/a.ts', 'runs/r.json', 'artifacts/a.txt',
  'brain/memory.db'];

async function project() {
  const base = await mkdtemp(join(tmpdir(), 'dn-agent-deny-')); roots.push(base);
  const root = join(base, 'project'), data = join(root, ...DATA.split('/'));
  const put = async (path: string, body: string) => { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, body); };
  await Promise.all([put(join(root, 'src', 'a.ts'), 'export const a = 1;\n'), put(join(root, '.deckent', 'config.json'), '{"layout":{}}\n'),
    put(join(data, 'notes.txt'), 'ordinary data file\n'), ...STATE_FILES.map(path => put(join(data, ...path.split('/')), `PRODUCT-STATE ${path}\n`))]);
  const layout = resolveProductLayout({ projectRoot: root, root: data });
  const deny = agentWorkspaceDeny(root, layout);
  return { base, root, data, layout, deny, scope: await createWorkspaceScope(root, deny) };
}

// TERM-FEEDBACK-1: the owner's live session listed and read other conversations under `.deckent/live-data/state/terminal-sessions`.
// Every product resource of the layout except its configuration is refused to the agent tools, and the same scope feeds the shell's
// path classification and both sandboxes (one source).
describe('agent workspace deny: the product state of a data root inside the project', () => {
  it('refuses every state resource to read_file, hides them from list_dir and grep, and still reads the configuration and project files', async () => {
    const p = await project();
    const tools = await createWorkspaceReadTools(p.root, { deny: p.deny });
    for (const path of STATE_FILES) {
      const read = await tools.execute('read_file', { path: `${DATA}/${path}` });
      expect(read.text, path).toContain('error=path-denied');
    }
    expect((await tools.execute('list_dir', { path: `${DATA}/state/terminal-sessions` })).text).toContain('error=path-denied');
    const state = await tools.execute('list_dir', { path: `${DATA}/state` });
    expect(state.text).not.toMatch(/terminal-sessions|ledger|runtime-service|backups|file-effects|terminal-history/);
    const data = await tools.execute('list_dir', { path: DATA });
    expect(data.text).toContain('notes.txt'); expect(data.text).not.toMatch(/policy\.json|bindings\.json|audit|approvals|workspaces|brain/);
    expect((await tools.execute('grep', { pattern: 'PRODUCT-STATE', path: '.deckent' })).text).not.toContain('PRODUCT-STATE ');
    expect((await tools.execute('read_file', { path: '.deckent/config.json' })).text).toContain('"layout"');
    expect((await tools.execute('read_file', { path: `${DATA}/notes.txt` })).text).toContain('ordinary data file');
    expect((await tools.execute('read_file', { path: 'src/a.ts' })).text).toContain('export const a = 1;');
  });

  it('classifies a shell read of product state as protected, and a project read as read-only', async () => {
    const p = await project();
    for (const path of ['state/terminal-sessions/other-session.json', 'state/ledger.db', 'policy.json']) {
      const verdict = await classifyReadOnlyShellCommand(`cat ${DATA}/${path}`, createShellPathContext(p.scope));
      expect(verdict, path).toMatchObject({ readOnly: false, reasonCode: 'PATH_PROTECTED' });
    }
    expect(await classifyReadOnlyShellCommand('cat src/a.ts .deckent/config.json', createShellPathContext(p.scope))).toMatchObject({ readOnly: true });
  });

  it('masks the product state in the bubblewrap view and gives it no Landlock rule', async () => {
    const p = await project();
    const view = await resolveBubblewrapView({ project: p.scope, scratchDir: null }, { PATH: '/usr/bin:/bin' });
    expect(view.ok).toBe(true); if (!view.ok) return;
    const masked = [...view.view.maskedDirectories, ...view.view.maskedFiles];
    for (const path of ['state/terminal-sessions', 'state/ledger.db', 'state/ledger.db-wal', 'policy.json', 'audit', 'approvals', 'workspaces']) {
      expect(masked, path).toContain(join(p.scope.root, ...DATA.split('/'), ...path.split('/')));
    }
    expect(masked).not.toContain(join(p.scope.root, '.deckent', 'config.json'));
    const built = await buildLandlockRules({ project: p.scope, scratchDir: null });
    expect(built.ok).toBe(true); if (!built.ok) return;
    const ruled = built.rules.map(([, path]) => path);
    for (const path of ['state/terminal-sessions', 'state/terminal-sessions/other-session.json', 'state/ledger.db', 'state/ledger.db-wal', 'policy.json']) {
      expect(ruled, path).not.toContain(`${DATA}/${path}`);
    }
    expect(ruled).toContain('.deckent/config.json');
  });

  // At the real boundary: the installed bubblewrap and bash; the runtime socket is live, as it is while the service runs.
  it.skipIf(!sandboxReady)('keeps the product state and the runtime socket out of a real bubblewrap shell, and the project readable', async () => {
    const p = await project();
    const socket = join(p.data, 'state', 'runtime.sock'), server = createServer(connection => connection.end('SERVICE-ANSWER\n'));
    servers.push(server); await new Promise<void>(done => server.listen(socket, done));
    const usable = bubblewrapShellSandbox({ project: p.scope, scratchDir: null }).usable(capabilities);
    expect(usable.ok).toBe(true); if (!usable.ok) return;
    const result = await usable.realm.run({ command: `cat src/a.ts; cat ${DATA}/state/terminal-sessions/other-session.json ${DATA}/state/ledger.db-wal ${DATA}/policy.json;`
      + ` ls ${DATA}/state/terminal-sessions; python3 -c 'import socket; s = socket.socket(socket.AF_UNIX); s.connect("${DATA}/state/runtime.sock"); print(s.recv(64))'`
      + ' 2>&1; true', cwd: p.scope.root, environment: { PATH: '/usr/bin:/bin', HOME: p.base }, fixedEnv: {}, timeoutMs: 20_000 });
    expect(result.output).toContain('export const a = 1;');
    expect(result.output).not.toContain('PRODUCT-STATE'); expect(result.output).not.toContain('SERVICE-ANSWER');
    // The masked directory lists empty (a tmpfs): no other conversation's name.
    expect(result.output).not.toMatch(/^other-session\.json$/m);
  });
});
