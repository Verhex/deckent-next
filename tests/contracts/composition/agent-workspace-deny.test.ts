import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentWorkspaceDeny, buildLandlockRules, createShellPathContext, createWorkspaceReadTools, createWorkspaceScope, landlockShellSandbox } from '#adapters/index.js';
import { bubblewrapShellSandbox, resolveBubblewrapView } from '#adapters/core/shell-sandbox-bwrap/index.js';
import { classifyReadOnlyShellCommand } from '#engine/index.js';
import { prepareProductFile, productResourcePath, resolveProductLayout } from '#platform/index.js';
import { measureTestShellHost } from '../../fixtures/shell-host.js';
import { WORKSPACE_DESCRIPTOR_CUSTODY_AVAILABLE } from '../../fixtures/workspace-descriptor-custody.js';

const capabilities = await measureTestShellHost();
const sandboxReady = capabilities.bubblewrap.status === 'available';
const custodyIt = it.skipIf(!WORKSPACE_DESCRIPTOR_CUSTODY_AVAILABLE);
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
  const layout = resolveProductLayout({ platform: process.platform === 'win32' ? 'win32' : 'posix', projectRoot: root, root: data });
  const deny = agentWorkspaceDeny(root, layout);
  return { base, root, data, layout, deny, scope: await createWorkspaceScope(root, deny) };
}

// TERM-FEEDBACK-1: the owner's live session listed and read other conversations under `.deckent/live-data/state/terminal-sessions`.
// Every product resource of the layout except its configuration is refused to the agent tools, and the same scope feeds the shell's
// path classification and both sandboxes (one source).
describe('agent workspace deny: the product state of a data root inside the project', () => {
  custodyIt('[requires Linux /proc/self/fd custody] refuses every state resource to read_file, hides them from list_dir and grep, and still reads the configuration and project files', async () => {
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

  it('classifies a shell read of product state as protected without granting platform custody', async () => {
    const p = await project();
    for (const path of ['state/terminal-sessions/other-session.json', 'state/ledger.db', 'policy.json']) {
      const verdict = await classifyReadOnlyShellCommand(`cat ${DATA}/${path}`, createShellPathContext({ ...p.scope, root: '/project' }));
      expect(verdict, path).toMatchObject({ readOnly: false, reasonCode: 'PATH_PROTECTED' });
    }
  });

  custodyIt('[requires Linux /proc/self/fd custody] classifies a project read as read-only', async () => {
    const p = await project();
    expect(await classifyReadOnlyShellCommand('cat src/a.ts .deckent/config.json', createShellPathContext(p.scope))).toMatchObject({ readOnly: true });
  });

  it.skipIf(process.platform === 'win32')('requires POSIX sandbox rule paths: masks the product state in the bubblewrap view and gives it no Landlock rule', async () => {
    const p = await project();
    const view = await resolveBubblewrapView({ project: p.scope, scratchDir: null }, { PATH: '/usr/bin:/bin' });
    expect(view.ok).toBe(true); if (!view.ok) return;
    const masked = [...view.view.maskedDirectories, ...view.view.maskedFiles, ...view.view.emptiedDirectories ?? []];
    // SANDBOX-AD-SIZINTISI: a directory that holds product state only is one empty tmpfs (its entries' names are not listed), so a path is
    // protected when it or a directory above it is masked.
    const covered = (path: string) => masked.some(mask => path === mask || path.startsWith(`${mask}/`));
    for (const path of ['state/terminal-sessions', 'state/ledger.db', 'state/ledger.db-wal', 'policy.json', 'audit', 'approvals', 'workspaces']) {
      expect(covered(join(p.scope.root, ...DATA.split('/'), ...path.split('/'))), path).toBe(true);
    }
    expect(covered(join(p.scope.root, '.deckent', 'config.json'))).toBe(false);
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
    const socket = join(p.data, 'state', 'runtime.sock'), server = createServer(connection => { connection.on('error', () => undefined); connection.end('SERVICE-ANSWER\n'); });
    servers.push(server); await new Promise<void>(done => server.listen(socket, done));
    const usable = bubblewrapShellSandbox({ project: p.scope, scratchDir: null }).usable(capabilities);
    expect(usable.ok).toBe(true); if (!usable.ok) return;
    const result = await usable.realm.run({ command: `cat src/a.ts; cat ${DATA}/state/terminal-sessions/other-session.json ${DATA}/state/ledger.db-wal ${DATA}/policy.json;`
      + ` ls ${DATA}/state/terminal-sessions; python3 -c 'import socket; s = socket.socket(socket.AF_UNIX); s.connect("${DATA}/state/runtime.sock"); print(s.recv(64))'`
      + ' 2>&1; true', cwd: p.scope.root, environment: { PATH: '/usr/bin:/bin', HOME: p.base, USERPROFILE: p.base }, fixedEnv: {}, timeoutMs: 20_000 });
    expect(result.output).toContain('export const a = 1;');
    expect(result.output).not.toContain('PRODUCT-STATE'); expect(result.output).not.toContain('SERVICE-ANSWER');
    // The masked directory lists empty (a tmpfs): no other conversation's name.
    expect(result.output).not.toMatch(/^other-session\.json$/m);
  });

  // SANDBOX-AD-SIZINTISI (top-20 #6): a directory that holds product state only is an empty tmpfs, so not even the names of its entries
  // (`ledger.db`, `runtime.sock`, `backups`) are listed; a directory that also holds the project's own files keeps per-entry masks, and the
  // project's own `.deckent/docs` stays writable (owner 2026-09-30 Y).
  // Lead decision (2026-10-06): the layout root is never emptied whole — on a fresh `.deckent` (data and host, no docs yet) a command creates `.deckent/docs`
  // and the file lands on the host (owner Y); the state names under `data` are still not listed, and the policy and ledger stay refused.
  it.skipIf(!sandboxReady)('a fresh layout root keeps `.deckent/docs` creatable (lands on the host) while the state below it stays unlisted and refused', async () => {
    const p = await project();
    await mkdir(join(p.root, '.deckent', 'host'), { recursive: true }); await writeFile(join(p.root, '.deckent', 'host', 'x.md'), 'HOST-SECRET\n');
    const usable = bubblewrapShellSandbox({ project: p.scope, scratchDir: null }).usable(capabilities);
    expect(usable.ok).toBe(true); if (!usable.ok) return;
    const result = await usable.realm.run({ command: `mkdir -p .deckent/docs && touch .deckent/docs/x; echo "docs=$?"; echo "state=[$(ls -A ${DATA}/state | tr '\\n' ' ')]";`
      + ` cat ${DATA}/policy.json 2>&1; echo "policy=$?"; cat ${DATA}/state/ledger.db 2>&1; echo "ledger=$?"; cat .deckent/host/x.md 2>&1; echo "host=$?"`,
    cwd: p.scope.root, environment: { PATH: '/usr/bin:/bin', HOME: p.base, USERPROFILE: p.base }, fixedEnv: {}, timeoutMs: 20_000 });
    const lines = result.output.split('\n');
    for (const line of ['docs=0', 'state=[]', 'policy=1', 'ledger=1']) expect(lines).toContain(line);
    expect(result.output).not.toMatch(/PRODUCT-STATE|HOST-SECRET/u);
    expect(await readFile(join(p.root, '.deckent', 'docs', 'x'), 'utf8')).toBe('');
    const view = await resolveBubblewrapView({ project: p.scope, scratchDir: null }, { PATH: '/usr/bin:/bin' });
    expect(view.ok && view.view.emptiedDirectories).not.toContain(join(p.root, '.deckent'));
  });
  it.skipIf(!sandboxReady)('lists no product state name inside a state-only directory, keeps the project own files and .deckent/docs readable and writable, and lands no write on the host state', async () => {
    const p = await project();
    await mkdir(join(p.root, '.deckent', 'docs'), { recursive: true }); await writeFile(join(p.root, '.deckent', 'docs', 'a.md'), 'doc\n');
    const usable = bubblewrapShellSandbox({ project: p.scope, scratchDir: null }).usable(capabilities);
    expect(usable.ok).toBe(true); if (!usable.ok) return;
    const result = await usable.realm.run({ command: `echo "state=[$(ls -A ${DATA}/state | tr '\\n' ' ')]"; echo "backups=[$(ls -A ${DATA}/state/backups 2>&1 | tr '\\n' ' ')]";`
      + ` cat ${DATA}/state/ledger.db 2>&1; echo "ledger=$?"; echo planted > ${DATA}/state/planted.txt; echo "plant=$?"; cat ${DATA}/notes.txt;`
      + ` cat ${DATA}/policy.json 2>&1; echo "policy=$?"; echo new > .deckent/docs/b.md; echo "docs=$?"; cat .deckent/docs/a.md`,
    cwd: p.scope.root, environment: { PATH: '/usr/bin:/bin', HOME: p.base, USERPROFILE: p.base }, fixedEnv: {}, timeoutMs: 20_000 });
    const lines = result.output.split('\n');
    expect(lines).toContain('state=[]');
    expect(result.output).not.toMatch(/ledger-1\.db|terminal-sessions|file-effects|terminal-history|runtime-service/u);
    expect(result.output).not.toContain('PRODUCT-STATE');
    expect(lines).toContain('ledger=1'); expect(lines).toContain('policy=1');
    expect(lines).toContain('ordinary data file'); expect(lines).toContain('docs=0'); expect(lines).toContain('doc');
    expect(await readFile(join(p.root, '.deckent', 'docs', 'b.md'), 'utf8')).toBe('new\n');
    // The state directory of the host is unchanged: the write landed in the sandbox's own tmpfs and ended with the call.
    await expect(readFile(join(p.data, 'state', 'planted.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(p.data, 'state', 'ledger.db'), 'utf8')).toBe('PRODUCT-STATE state/ledger.db\n');
  });
});

// Astra 2162: the product state stays closed to both sandboxes when an ancestor is an ignored directory — a `.gitignore` entry for
// `.deckent/`, or a data root under the baseline-ignored `.cache` — and the protection does not depend on `.gitignore`. Read and write
// are refused, ordinary project files and the conversation scratch area keep working; a chain through a symbolic link refuses the call.
describe.skipIf(!sandboxReady || capabilities.landlock.status !== 'available')('product state under an ignored ancestor (Astra 2162)', () => {
  async function layoutAt(dataRel: string, gitignore: string | null) {
    const base = await mkdtemp(join(tmpdir(), 'dn-ignored-state-')); roots.push(base);
    const root = join(base, 'project'), data = join(root, ...dataRel.split('/')), scratch = join(base, 'scratch');
    await mkdir(data, { recursive: true, mode: 0o700 }); await mkdir(join(root, 'src'), { recursive: true }); await mkdir(scratch, { recursive: true, mode: 0o700 });
    await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    if (gitignore !== null) await writeFile(join(root, '.gitignore'), gitignore);
    const layout = resolveProductLayout({ platform: process.platform === 'win32' ? 'win32' : 'posix', projectRoot: root, root: data });
    const ledger = await prepareProductFile(layout, 'ledger'); await writeFile(ledger, 'SYNTHETIC_PRODUCT_STATE\n');
    const deny = agentWorkspaceDeny(root, layout), scope = await createWorkspaceScope(root, deny);
    const rel = ledger.slice(root.length + 1);
    return { root, scope, scratch, ledger, rel, sandbox: { project: scope, scratchDir: scratch } };
  }
  const environment = { PATH: '/usr/bin:/bin', HOME: '/nonexistent-home', USERPROFILE: '/nonexistent-home' };
  // Astra 2164: `[` is a plain character in the deny matcher's language; an anchor is cut only at the matcher's own wildcards (`*`, `?`).
  for (const [name, dataRel, gitignore] of [['a .gitignore entry for the data root parent', '.deckent/live-data', '.deckent/\n'], ['a baseline-ignored data root parent', '.cache/deckent', null],
    ['a baseline-ignored parent with brackets in the data root', '.cache/deckent[1]', null], ['a bracketed and braced custom resource ancestor', '.cache/x[a]/y{z}/deckent', null]] as const) {
    it(`refuses the ledger to both realms under ${name}, keeps the project and the scratch area writable`, async () => {
      const p = await layoutAt(dataRel, gitignore);
      expect(p.scope.denied(p.rel)).toBe(true);
      for (const provider of [bubblewrapShellSandbox(p.sandbox), landlockShellSandbox(p.sandbox)]) {
        const usable = provider.usable(capabilities); if (!usable.ok) throw new Error(usable.reason);
        const ran = await usable.realm.run({ command: `cat '${p.rel}' 2>&1; echo "cat=$?"; printf 'SYNTHETIC_WRITE\\n' >> '${p.rel}' 2>&1; echo "append=$?";`
          + ` echo ok > src/made.txt; echo "project=$?"; echo s > "$TMPDIR/s.txt"; echo "scratch=$?"; cat src/a.ts`, cwd: p.root, environment, fixedEnv: { TMPDIR: p.scratch }, timeoutMs: 20_000 });
        const lines = ran.output.split('\n');
        expect(ran.output, provider.kind).not.toContain('SYNTHETIC');
        for (const line of ['cat=1', 'append=1', 'project=0', 'scratch=0', 'export const a = 1;']) expect(lines, provider.kind).toContain(line);
        expect(await readFile(p.ledger, 'utf8'), provider.kind).toBe('SYNTHETIC_PRODUCT_STATE\n');
        expect(await readFile(join(p.root, 'src', 'made.txt'), 'utf8'), provider.kind).toBe('ok\n'); expect(await readFile(join(p.scratch, 's.txt'), 'utf8'), provider.kind).toBe('s\n');
        await rm(join(p.root, 'src', 'made.txt')); await rm(join(p.scratch, 's.txt'));
      }
      const view = await resolveBubblewrapView(p.sandbox, environment);
      expect(view.ok && [...view.view.maskedFiles, ...view.view.maskedDirectories, ...view.view.emptiedDirectories ?? []].some(mask => p.ledger === mask || p.ledger.startsWith(`${mask}/`))).toBe(true);
      const rules = await buildLandlockRules(p.sandbox);
      expect(rules.ok && rules.rules.some(([cls, path]) => cls === 'w' && (path === '.' || p.rel.startsWith(`${path}/`)))).toBe(false);
    });
  }
  // Merge Astra 2170 x MODES-3: the write floor holds inside a carved ignored ancestor too. With `.deckent/` ignored and the data root beneath it,
  // the Landlock carve used to grant every other `.deckent` entry read-write, floor or not (the full-access configuration file included).
  it('keeps the write floor read-only inside a carved ignored ancestor, in both realms, for the approval floor and the full-access floor', async () => {
    const p = await layoutAt('.deckent/live-data', '.deckent/\n');
    await writeFile(join(p.root, '.deckent', 'config.json'), 'CONFIG\n'); await writeFile(join(p.root, '.deckent', 'notes.md'), 'NOTES\n');
    const approvalFloor = (rel: string) => rel === '.deckent/-' || rel.startsWith('.deckent/'), configOnly = (rel: string) => rel.startsWith('.deckent/config.json');
    // Lead decision 2026-10-09 (deliberate tightening): this layout carries no turn hard floor, so the fail-closed fallback floors every
    // existing `.deckent` entry but `docs`; `.deckent/notes.md` is read-only in the full-access floor too (was 'w').
    for (const [label, writeFloor, notes] of [['approval floor', approvalFloor, 'r'], ['full-access floor', configOnly, 'r']] as const) {
      const layout = { ...p.sandbox, writeFloor };
      const rules = await buildLandlockRules(layout, {}, undefined, { floorReadOnly: true });
      const classOf = (path: string) => rules.ok ? rules.rules.find(([, rule]) => rule === path)?.[0] : 'refused';
      expect({ label, config: classOf('.deckent/config.json'), notes: classOf('.deckent/notes.md') }).toEqual({ label, config: 'r', notes });
      for (const provider of [bubblewrapShellSandbox(layout), landlockShellSandbox(layout)]) {
        const usable = provider.usable(capabilities); if (!usable.ok) throw new Error(usable.reason);
        const ran = await usable.realm.run({ command: 'echo X >> .deckent/config.json; echo "config=$?"; echo Y >> .deckent/notes.md; echo "notes=$?"', cwd: p.root, environment,
          fixedEnv: { TMPDIR: p.scratch }, timeoutMs: 20_000, writeFloorReadOnly: true });
        expect({ label, kind: provider.kind, config: ran.output.includes('config=0') }).toEqual({ label, kind: provider.kind, config: false });
        expect({ label, kind: provider.kind, notes: ran.output.includes('notes=0') }).toEqual({ label, kind: provider.kind, notes: notes === 'w' });
        expect(await readFile(join(p.root, '.deckent', 'config.json'), 'utf8')).toBe('CONFIG\n');
        await writeFile(join(p.root, '.deckent', 'notes.md'), 'NOTES\n');
      }
    }
  });
  it('refuses the call when the product state lies behind a symbolic link on its ancestor chain', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dn-ignored-link-')); roots.push(base);
    const root = join(base, 'project'), real = join(base, 'elsewhere'); await mkdir(join(real, 'deckent'), { recursive: true }); await mkdir(join(root, '.cache'), { recursive: true });
    await symlink(join(real, 'deckent'), join(root, '.cache', 'deckent'));
    // The product's own file preparation refuses a linked data root (MANAGED_FILE_UNSAFE); the file is placed by hand to prove the realms refuse too.
    const layout = resolveProductLayout({ platform: process.platform === 'win32' ? 'win32' : 'posix', projectRoot: root, root: join(root, '.cache', 'deckent') });
    const ledger = productResourcePath(layout, 'ledger'); await mkdir(join(ledger, '..'), { recursive: true }); await writeFile(ledger, 'SYNTHETIC_PRODUCT_STATE\n');
    const scope = await createWorkspaceScope(root, agentWorkspaceDeny(root, layout));
    const sandbox = { project: scope, scratchDir: null };
    expect(await resolveBubblewrapView(sandbox, environment)).toMatchObject({ ok: false, reason: expect.stringContaining('symbolic link') });
    expect(await buildLandlockRules(sandbox)).toMatchObject({ ok: false, reason: expect.stringContaining('symbolic link') });
    for (const provider of [bubblewrapShellSandbox(sandbox), landlockShellSandbox(sandbox)]) {
      const usable = provider.usable(capabilities); if (!usable.ok) throw new Error(usable.reason);
      const ran = await usable.realm.run({ command: 'cat .cache/deckent/state/ledger.db', cwd: root, environment, timeoutMs: 20_000 });
      expect(ran, provider.kind).toMatchObject({ status: 'spawn-failed' }); expect(ran.output, provider.kind).not.toContain('SYNTHETIC');
    }
  });
});

// Anchor derivation is pure deny grammar; it requires neither descriptor custody nor native sandboxes.
it('derives anchors with the deny matcher\'s own wildcard language: brackets are literal, `*`/`?` cut (Astra 2164)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dn-deny-anchors-')); roots.push(root);
  const scope = await createWorkspaceScope(root, ['.cache/deckent[1]/state/ledger.db*', '.cache/deckent[1]/state/ledger.db/**',
      '.cache/deckent[1]/state/.ledger.db*', '**/.env', '.env', 'a/b?c/d*', 'plain/dir/']);
  expect([...scope.protectedAnchors].sort()).toEqual(['.cache/deckent[1]/state/.ledger.db', '.cache/deckent[1]/state/ledger.db', 'a/b', 'plain/dir']);
  expect(scope.protectedAnchors.has('.cache/deckent')).toBe(false);
});
