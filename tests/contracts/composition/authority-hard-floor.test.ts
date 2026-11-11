import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentWorkspaceDeny, createShellPathContext, createWorkspaceReadTools, createWorkspaceScope, projectEditArea, resolveBubblewrapView, type ShellSandboxLayout } from '#adapters/index.js';
import { classifyReadOnlyShellCommand, classifyShellRisk, decideAgentToolCall } from '#engine/index.js';
import { getPolicyVocabulary, installationOwnerPermissions, INSTALLATION_OWNER_ROLE_ID, resolvePolicyBindings } from '#domain/index.js';
import { resolveProductLayout } from '#platform/index.js';
import { closeModeRuntimes, modeRuntime, rule } from '../support/agent-turn-modes.js';
import { WORKSPACE_DESCRIPTOR_CUSTODY_AVAILABLE } from '../../fixtures/workspace-descriptor-custody.js';

// POLICY-ADMIN (owner F2): the hard floor — policy, bindings, approval records and key, ledger, credentials, `.git` internals — is never
// opened to the agent tools by any grant or mode. Here the person holds the owner root (every vocabulary kind, 'all') and full-auto: the
// floor is path-level code that consults no policy, so the maximal policy changes nothing.
const roots: string[] = [];
const custodyIt = it.skipIf(!WORKSPACE_DESCRIPTOR_CUSTODY_AVAILABLE);
afterEach(async () => { vi.unstubAllEnvs(); await closeModeRuntimes(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const DATA = '.deckent/live-data';
const FLOOR = [`${DATA}/policy.json`, `${DATA}/bindings.json`, `${DATA}/approvals/authority.key`, `${DATA}/state/ledger.db`, `${DATA}/state/ledger.db-wal`,
  `${DATA}/audit/authority-revisions/k-1.json`, '.git/config', '.git/hooks/pre-commit', '.env', 'keys/server.pem'];
const principal = { id: 'os:1000', issuer: 'host', subject: '1000', assurance: 'os-user' as const, scopeIds: ['s'] };
const kinds = getPolicyVocabulary().resources.map(resource => resource.kind);
// PRE-9 (b): the stored full-auto counts only while a grant allows it, so the owner root allows `permission-mode` (every other kind asks, mode-eligible).
const maximal = resolvePolicyBindings({ schemaVersion: 2, revision: 'p1', grants: [], restrictions: [], separationOfDuties: [],
  roles: [{ id: INSTALLATION_OWNER_ROLE_ID, permissions: installationOwnerPermissions(kinds).map(permission => permission.resource.kind === 'permission-mode' ? permission
    : ({ ...permission, effect: 'require-approval', modeEligible: true })) }] },
{ schemaVersion: 2, revision: 'b1', bindings: [{ id: 'root', principals: [{ issuer: 'host', subject: '1000' }], roles: [INSTALLATION_OWNER_ROLE_ID], scopes: 'all' }],
  modes: [{ id: 'fa', principal: { issuer: 'host', subject: '1000' }, scopes: ['s'], mode: 'full-auto' }] });

async function project() {
  const base = await mkdtemp(join(tmpdir(), 'dn-hard-floor-')); roots.push(base);
  const root = join(base, 'project');
  for (const path of [...FLOOR, 'src/a.ts']) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), `FLOOR ${path}\n`); }
  const layout = resolveProductLayout({ platform: process.platform === 'win32' ? 'win32' : 'posix', projectRoot: root, root: join(root, ...DATA.split('/')) });
  const scope = await createWorkspaceScope(root, agentWorkspaceDeny(root, layout));
  return { root, layout, scope };
}

describe('authority hard floor under the owner root and full-auto', () => {
  custodyIt('[requires Linux /proc/self/fd custody] refuses every hard-floor path to read', async () => {
    const { root, layout } = await project();
    const tools = await createWorkspaceReadTools(root, { deny: agentWorkspaceDeny(root, layout) });
    for (const path of FLOOR) expect((await tools.execute('read_file', { path })).text, path).toContain('error=path-denied');
  });
  it('refuses hard-floor edit planning and shell classification without granting platform custody', async () => {
    const { scope } = await project();
    const edits = projectEditArea(scope);
    for (const path of FLOOR) {
      expect(await edits.plan('write_file', { path, content: 'x' }), path).toMatchObject({ ok: false });
      expect(await classifyReadOnlyShellCommand(`cat ${path}`, createShellPathContext({ ...scope, root: '/project' })), path).toMatchObject({ readOnly: false, reasonCode: 'PATH_PROTECTED' });
    }
  });
  custodyIt('[requires Linux /proc/self/fd custody] plans an ordinary source edit', async () => {
    const { scope } = await project();
    expect(await projectEditArea(scope).plan('write_file', { path: 'src/a.ts', content: 'x' })).toMatchObject({ ok: true });
  });
  it('keeps edit-floor approval under the maximal owner policy in full-auto', () => {
    // The maximal policy lowers an ordinary edit in full-auto, but never the write floor (`.deckent/config.json`, CI, manifests).
    const decide = (cell: 'edit' | 'edit-floor') => decideAgentToolCall(maximal, { principal, scopeId: 's', tool: { name: 'write_file' }, operation: { id: 'workspace.file.write' }, cell });
    expect(decide('edit')).toMatchObject({ decision: 'allow', relaxation: { mode: 'full-auto' } });
    expect(decide('edit-floor')).toMatchObject({ decision: 'require-approval', relaxation: null });
  });
});

// K15: the allow answer is armed for the original attack, never replaced with a harmless command.
custodyIt('K15: login canaries stay private through file tools and approved host shell attacks', async () => {
  const f = await modeRuntime({ mode: 'ask', shell: { schemaVersion: 1, realm: 'host' }, grants: [
    rule('tools', 'agent-tool', ['edit_file', 'write_file', 'run_shell', 'scratch_write'], 'require-approval'),
    rule('read', 'agent-tool', ['read_file', 'list_dir', 'grep', 'glob', 'scratch_read', 'scratch_list'], 'allow'),
    rule('effects', 'operation', ['host.shell.run', 'workspace.file.write', 'workspace.scratch.write'], 'allow')] });
  vi.stubEnv('HOME', f.env.HOME!);
  const global = process.env['DECKENT_GLOBAL_HOME']!, login = join(global, 'headless/logins/codex'), credential = join(login, 'auth.json');
  const canary = 'K15-SYNTHETIC-LOGIN-CANARY';
  await mkdir(login, { recursive: true }); await writeFile(credential, canary);
  await symlink(login, join(f.project, 'login-link'));
  await link(credential, join(f.project, 'login-hardlink'));
  const paths = [credential, relative(f.project, credential), 'login-link/auth.json', 'login-hardlink'];
  for (const path of paths) {
    for (const [tool, args] of [['read_file', { path }], ['write_file', { path, content: 'CHANGED' }], ['run_shell', { command: `cat "${path}"` }]] as const) {
      const result = await f.call(tool, args, 'allow');
      expect(result, f.evidence(result)).toMatchObject({ card: false, status: 'error' });
      if (tool === 'run_shell') expect(result.text).toContain('PRODUCT_STATE_PROTECTED');
      expect(JSON.stringify([result, f.audit(true), f.policyTurns(), f.sent])).not.toContain(canary);
      expect(await readFile(credential, 'utf8')).toBe(canary);
    }
  }
  for (const command of [`cat<"${credential}"`, `printf X>"${credential}"`, `dd if="${credential}"`,
    'cat "$HOME/.deckent/headless/logins/codex/auth.json"', 'cat "${HOME}/.deckent/headless/logins/codex/auth.json"',
    'cat ~/.deckent/headless/logins/codex/auth.json', 'cat "$DECKENT_GLOBAL_HOME/headless/logins/codex/auth.json"',
    `cat "${global}/headless/logins/*/auth.json"`]) {
    const result = await f.call('run_shell', { command }, 'allow');
    expect(result, f.evidence(result)).toMatchObject({ card: false, status: 'error' });
    expect(result.text).toContain('PRODUCT_STATE_PROTECTED');
    expect(JSON.stringify([result, f.audit(true), f.policyTurns(), f.sent])).not.toContain(canary);
    expect(await readFile(credential, 'utf8')).toBe(canary);
  }
  for (const [tool, args] of [['list_dir', { path: login }], ['grep', { path: login, pattern: 'K15' }],
    ['glob', { path: login, pattern: '**/*' }], ['edit_file', { path: credential, old_string: 'fixture-old', new_string: 'CHANGED' }],
    ['scratch_read', { path: credential }], ['scratch_list', { path: login }], ['scratch_write', { path: credential, content: 'CHANGED' }]] as const) {
    const result = await f.call(tool, args, 'allow');
    expect(result, f.evidence(result)).toMatchObject({ card: false, status: 'error' });
    expect(JSON.stringify([result, f.audit(true), f.policyTurns(), f.sent])).not.toContain(canary);
    expect(await readFile(credential, 'utf8')).toBe(canary);
  }
  // An API turn retains its ordinary host-shell approval and executes the exact approved command.
  const ordinary = await f.call('run_shell', { command: 'printf API_HOST_STILL_WORKS' }, 'allow');
  expect(ordinary, f.evidence(ordinary)).toMatchObject({ card: true, status: 'ok' });
  expect(ordinary.text).toContain('API_HOST_STILL_WORKS');
});

custodyIt('K15C: unresolved host forms show the warning even under allow/full-auto and execute only after the exact card is approved', async () => {
  const f = await modeRuntime({ mode: 'full-auto', shell: { schemaVersion: 1, realm: 'host' }, grants: [
    rule('shell', 'agent-tool', ['run_shell'], 'allow'), rule('effects', 'operation', ['host.shell.run'], 'allow')] });
  vi.stubEnv('HOME', f.env.HOME!);
  const credential = join(f.env.HOME!, '.deckent/headless/logins/codex/auth.json'), canary = 'K15B-HOST-LOGIN-CANARY';
  await mkdir(join(credential, '..'), { recursive: true }); await writeFile(credential, canary);
  const suffix = '.deckent/headless/logins/codex/auth.json';
  const commands = [
    `cd ~ && cat ${suffix}`, `pushd ~; cat ${suffix}`,
    `cat "$(printf %s ~)/${suffix}"`, `cat "\`printf %s ~\`/${suffix}"`,
    `X=~; cat "$X/${suffix}"`, `cat "\${X:-$HOME}/${suffix}"`,
    'find ~ -name auth.json -exec cat {} \\;', 'find ~ -name auth.json | xargs cat',
    `cd ${relative(f.project, f.env.HOME!)} && cat ${suffix}`,
    `(cd ~ && cat ${suffix})`, `cd</dev/null ~ && cat ${suffix}`,
    'cat ~+/src/a.ts', 'cat ~other/file', 'cat src/{a,b}.ts', 'cat <(pwd)', 'cat "unterminated',
  ];
  const denied = await f.call('run_shell', { command: commands[0]! }, 'deny');
  expect(denied, f.evidence(denied)).toMatchObject({ card: true, status: 'denied' });
  expect(JSON.stringify([denied, f.sent])).not.toContain(canary);
  expect(f.rows('SELECT * FROM effect_intents')).toEqual([]);
  const measurements = [];
  for (const command of commands) {
    const grammar = await classifyReadOnlyShellCommand(command, createShellPathContext(await createWorkspaceScope(f.project)));
    const result = await f.call('run_shell', { command }, 'allow');
    const card = result.events.find(event => event.kind === 'approval.requested');
    expect(card, f.evidence(result)).toMatchObject({ kind: 'approval.requested',
      preview: expect.stringContaining('The working directory could not be verified;'),
      call: { kind: 'shell', command, reason: expect.stringContaining("this command may reach deckent's state folder") } });
    expect(result.text).not.toContain('HOST_GLOBAL_STATE_UNRESOLVED');
    measurements.push({ command, grammar: grammar.reasonCode, risk: classifyShellRisk(command, grammar).risk,
      card: result.card, status: result.status, reached: result.text.includes(canary) });
  }
  console.info('K15C_HOST_GRAMMAR', JSON.stringify(measurements));
  expect(measurements).toEqual(commands.map(command => expect.objectContaining({ command, card: true })));
  // Owner decision: approval can expose computed state paths on the host; do not claim this is confinement.
  expect(measurements[0]).toMatchObject({ status: 'ok', reached: true });
  expect(await readFile(credential, 'utf8')).toBe(canary);
  expect(f.rows('SELECT * FROM effect_intents').length).toBeGreaterThan(0);
  await f.writeAuthority([rule('shell', 'agent-tool', ['run_shell'], 'deny'), rule('effects', 'operation', ['host.shell.run'], 'allow')], 'full-auto', 'denied');
  expect(await f.call('run_shell', { command: commands[0]! }, 'allow')).toMatchObject({ card: false, status: 'denied' });
});

custodyIt('K15B: approved shell runs an ordinary pnpm-style hard link while file tools keep refusing it', async () => {
  for (const realm of ['host', 'require-sandbox'] as const) {
    const f = await modeRuntime({ mode: 'ask', shell: { schemaVersion: 1, realm }, grants: [
      rule('shell', 'agent-tool', ['run_shell'], 'require-approval'), rule('read', 'agent-tool', ['read_file'], 'allow'),
      rule('effects', 'operation', ['host.shell.run'], 'allow')] });
    vi.stubEnv('HOME', f.env.HOME!);
    await mkdir(join(f.project, 'node_modules/fixture'), { recursive: true });
    await writeFile(join(f.project, 'package-store'), 'K15B-PNPM-OK');
    await link(join(f.project, 'package-store'), join(f.project, 'node_modules/fixture/index.js'));
    const result = await f.call('run_shell', { command: 'cat node_modules/fixture/index.js' }, 'allow');
    expect(result, f.evidence(result)).toMatchObject({ card: true, status: 'ok' });
    expect(result.text).toContain('K15B-PNPM-OK');
    const read = await f.call('read_file', { path: 'node_modules/fixture/index.js' }, 'allow');
    expect(read).toMatchObject({ card: false, status: 'error' }); expect(read.text).toContain('hardlink-refused');
  }
});

custodyIt('K15: registry login files and every in-project global-root name stay closed to file tools', async () => {
  const { root, layout } = await project();
  const global = join(root, 'global-state'), home = join(root, 'person');
  const env = { HOME: home, DECKENT_GLOBAL_HOME: global };
  const names = ['global-state/unregistered.txt', 'person/.deckent/unregistered.txt', 'custom/headless/logins/codex/auth.json',
    'custom/headless/logins/claude/.credentials.json'];
  for (const name of [...names, 'src/auth.json']) { await mkdir(join(root, name, '..'), { recursive: true }); await writeFile(join(root, name), 'K15-IN-PROJECT-CANARY'); }
  const tools = await createWorkspaceReadTools(root, { deny: agentWorkspaceDeny(root, layout, true, env) });
  const edits = projectEditArea(tools.scope);
  for (const path of names) {
    expect(await tools.execute('read_file', { path })).toMatchObject({ status: 'error' });
    expect((await tools.execute('read_file', { path })).text).not.toContain('K15-IN-PROJECT-CANARY');
    expect(await edits.plan('write_file', { path, content: 'CHANGED' })).toMatchObject({ ok: false });
    expect(await readFile(join(root, path), 'utf8')).toBe('K15-IN-PROJECT-CANARY');
  }
  expect(await tools.execute('read_file', { path: 'src/auth.json' })).toMatchObject({ status: 'ok' });
});

custodyIt('K15B: project=HOME closes conventional and nonstandard global roots through product tools', async () => {
  const { root, layout } = await project(), env = { HOME: root, DECKENT_GLOBAL_HOME: join(root, 'nonstandard-global') };
  const canary = 'K15B-HOME-CANARY', paths = ['.deckent/unregistered.txt', 'nonstandard-global/unregistered.txt'];
  const tools = await createWorkspaceReadTools(root, { deny: agentWorkspaceDeny(root, layout, true, env) });
  for (const path of paths) {
    const directory = join(path, '..');
    await mkdir(join(root, directory), { recursive: true }); await writeFile(join(root, path), canary);
    for (const [tool, args] of [['read_file', { path }], ['list_dir', { path: directory }], ['grep', { path: directory, pattern: 'K15B' }],
      ['glob', { path: directory, pattern: '**/*' }]] as const) {
      const result = await tools.execute(tool, args);
      expect(result, tool).toMatchObject({ status: 'error' }); expect(result.text).not.toContain(canary);
    }
    for (const [tool, args] of [['write_file', { path, content: 'CHANGED' }],
      ['edit_file', { path, old_string: canary, new_string: 'CHANGED' }]] as const) expect(await projectEditArea(tools.scope).plan(tool, args)).toMatchObject({ ok: false });
    expect(await readFile(join(root, path), 'utf8')).toBe(canary);
  }
});

custodyIt('K15B: the runtime MCP launch layout hides both configured and conventional global roots', async () => {
  const layouts: ShellSandboxLayout[] = [];
  const f = await modeRuntime({ mode: 'ask', grants: [rule('read', 'agent-tool', ['read_file'], 'allow')],
    sandboxes: layout => { layouts.push(layout); return []; } });
  vi.stubEnv('HOME', f.env.HOME!);
  expect(await f.call('read_file', { path: 'src/a.ts' }, 'allow')).toMatchObject({ status: 'ok', card: false });
  const mcp = layouts.find(layout => layout.scratchDir === null)!;
  expect(mcp.hardFloor?.roots).toEqual(expect.arrayContaining([process.env['DECKENT_GLOBAL_HOME'], join(f.env.HOME!, '.deckent')]));
  const view = await resolveBubblewrapView(mcp, f.env, {}, { projectReadOnly: true, floorReadOnly: true });
  expect(view).toMatchObject({ ok: true });
  if (!view.ok) throw new Error(view.reason);
  expect(view.view.hiddenPaths).toEqual(expect.arrayContaining([process.env['DECKENT_GLOBAL_HOME'], join(f.env.HOME!, '.deckent')]));
});
