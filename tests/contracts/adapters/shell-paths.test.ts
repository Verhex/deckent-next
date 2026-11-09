import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentLoginIdentityPaths, createShellGlobalStateCheck, createShellPathContext, createWorkspaceScope, DEFAULT_WORKSPACE_READ_DENY, hostGlobalStateUnresolved } from '#adapters/index.js';
import { classifyReadOnlyShellCommand, type ShellReasonCode } from '#engine/index.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

/** A real workspace holding every file the legacy read-only matrix names, plus credential carriers and links. */
async function workspace() {
  const base = await mkdtemp(join(tmpdir(), 'dn-shell-paths-')); roots.push(base);
  const root = join(base, 'project'), outside = join(base, 'outside');
  for (const dir of ['docs', 'src', '.brain/exports', '.git', 'keys', 'notes']) await mkdir(join(root, dir), { recursive: true });
  await mkdir(outside);
  for (const file of ['docs/MASTER-PLAN.md', 'file', 'f', 'g', 'src/a.ts', 'src/b.ts', 'src/x.ts', 'f.json', 'a', 'b', 'README.md', '.brain/exports/summary.md',
    '.brain/memory.db', 'file with space.txt', '-file', '.env', '.env.production', '.git/config', 'keys/prod.key', 'file.pem', 'id_rsa', 'notes/credentials',
    'archive.zip', 'in', 'pats.txt', 'store.jks', 'secrets.json']) await writeFile(join(root, file), 'x\n');
  await writeFile(join(outside, 'secret'), 'outside\n');
  await symlink(join(root, '.env'), join(root, 'notes.txt'));
  await symlink(outside, join(root, 'linked'));
  return { root, scope: await createWorkspaceScope(root) };
}

describe.skipIf(process.platform !== 'linux')('shell path check over the workspace scope (T-L4 slice 3a)', () => {
  it('keeps the legacy read-only commands read-only against real files', async () => {
    const { scope } = await workspace();
    for (const command of ["sed -n '1,50p' docs/MASTER-PLAN.md", 'grep -l foo src/*.ts', 'grep -r x . 2>&1 | head', 'wc -l < f', 'diff a b', 'ls -R src',
      "find . -name '*.ts'", 'du -sh .', 'git diff HEAD~1 -- src/x.ts', 'less README.md', 'cat .brain/exports/summary.md', 'ls .brain',
      "cat 'file with space.txt'", 'cat -- -file', 'tr -d "\\n" < f', "jq -r '.[] | .name' f.json", 'grep -f pats.txt src/a.ts']) {
      expect(await classifyReadOnlyShellCommand(command, createShellPathContext(scope)), command).toMatchObject({ readOnly: true });
    }
  });

  it.each<[string, ShellReasonCode]>([
    ['cat /etc/passwd', 'PATH_OUTSIDE_ROOT'], ['cat ~/.ssh/id_rsa', 'PATH_OUTSIDE_ROOT'], ['cat ../secret', 'PATH_OUTSIDE_ROOT'], ['cat src/../../x', 'PATH_OUTSIDE_ROOT'],
    ['grep -r x /', 'PATH_OUTSIDE_ROOT'], ['git log -- ../x', 'PATH_OUTSIDE_ROOT'], ['git -C ../other status', 'PATH_OUTSIDE_ROOT'], ['diff a ../b', 'PATH_OUTSIDE_ROOT'],
    ['cat .env', 'PATH_PROTECTED'], ['cat src/../.env', 'PATH_PROTECTED'], ['cat .env.production', 'PATH_PROTECTED'], ['cat .brain/memory.db', 'PATH_PROTECTED'],
    ['stat .brain/memory.db', 'PATH_PROTECTED'], ['cat .brain/*', 'PATH_PROTECTED'], ['cat .git/config', 'PATH_PROTECTED'], ['ls .git', 'PATH_PROTECTED'],
    ['cat file.pem', 'PATH_PROTECTED'], ['cat keys/prod.key', 'PATH_PROTECTED'], ['cat id_rsa', 'PATH_PROTECTED'], ['cat notes/credentials', 'PATH_PROTECTED'],
    ['head -1 .*', 'PATH_PROTECTED'], ['cat *', 'PATH_PROTECTED'], ['cat store.jks', 'PATH_PROTECTED'], ['cat secrets.json', 'PATH_PROTECTED'],
    // G2-2: the file jq reads through --rawfile/--slurpfile is checked like any other read (it once shifted into the script slot and was skipped).
    ['jq --rawfile raw /etc/passwd . f.json', 'PATH_OUTSIDE_ROOT'], ['jq --slurpfile all .env . f.json', 'PATH_PROTECTED'],
    ['jq --rawfile raw ../outside/secret . f.json', 'PATH_OUTSIDE_ROOT'], ["jq -n --rawfile k keys/prod.key '$k'", 'PATH_PROTECTED'],
    // Real-filesystem cases the lexical legacy matrix could not show.
    ['cat notes.txt', 'PATH_PROTECTED'], ['cat linked/secret', 'PATH_OUTSIDE_ROOT'], ['cat missing.txt', 'PATH_UNRESOLVED'], ['cat *.nomatch', 'GLOB_EXPANSION'],
    ['wc -l < .env', 'PATH_PROTECTED'], ['grep -f .env src/a.ts', 'PATH_PROTECTED'],
  ])('%s → %s', async (command, reasonCode) => {
    const { scope } = await workspace();
    expect(await classifyReadOnlyShellCommand(command, createShellPathContext(scope)), command).toMatchObject({ readOnly: false, reasonCode });
  });

  // Known limit (legacy-inherited): traversal and git object reads are read-only with risk `low`, yet the shell itself will walk into
  // denied files or print repository objects no path check sees. Slice 3c must not run `low` silently on the strength of this verdict.
  it('classifies traversal and git object reads as read-only with risk low, although no path check covers what they reach', async () => {
    const { scope } = await workspace();
    for (const command of ['grep -r x .', 'rg x .', 'find . -type f', 'git show HEAD:.env', 'git log -p', 'git cat-file -p HEAD']) {
      expect(await classifyReadOnlyShellCommand(command, createShellPathContext(scope)), command).toMatchObject({ readOnly: true, risk: 'low' });
    }
  });

  // Astra 2111: the kernel resolves components in order, so `..` after a symlink is the parent of the link's target, not the
  // lexical parent. The check must examine that object (or ask), never the lexically normalized path.
  it('checks the object the kernel opens when `..` follows a symlink, and keeps `..` through a real directory read-only (Astra 2111)', async () => {
    const { root, scope } = await workspace();
    const outside = join(root, '..', 'outside');
    await mkdir(join(outside, 'sub'));
    await writeFile(join(outside, 'public.txt'), 'OUTSIDE_SYNTHETIC_SENTINEL\n');
    await writeFile(join(root, 'public.txt'), 'inside\n');
    await symlink(join(outside, 'sub'), join(root, 'deep'));
    await symlink(join(root, 'src'), join(root, 'inner'));
    for (const [command, reasonCode] of [['cat deep/../public.txt', 'PATH_OUTSIDE_ROOT'], ['ls deep/..', 'PATH_OUTSIDE_ROOT'], ['cat deep/../*.txt', 'PATH_OUTSIDE_ROOT'],
      [`cat ${root}/deep/../public.txt`, 'PATH_OUTSIDE_ROOT'], ['wc -l < deep/../public.txt', 'PATH_OUTSIDE_ROOT'], ['cat deep/../missing.txt', 'PATH_UNRESOLVED'],
      ['cat src/*/../a.ts', 'GLOB_UNSUPPORTED']] as const) {
      expect(await classifyReadOnlyShellCommand(command, createShellPathContext(scope)), command).toMatchObject({ readOnly: false, reasonCode });
    }
    const context = createShellPathContext(scope);
    for (const command of ['cat src/../public.txt', 'ls src/..', 'cat inner/../public.txt', 'cat src/../pub*.txt', 'cat inner/../src/a.ts']) {
      expect(await classifyReadOnlyShellCommand(command, context), command).toMatchObject({ readOnly: true, risk: 'none' });
    }
  });

  it('bounds glob expansion, accepts an absolute path inside the root and reports the examined paths root-relative', async () => {
    const { root, scope } = await workspace();
    expect(await classifyReadOnlyShellCommand('cat src/*.ts', createShellPathContext(scope, 2))).toMatchObject({ readOnly: false, reasonCode: 'GLOB_EXPANSION' });
    expect(await classifyReadOnlyShellCommand('cat src/*.ts', createShellPathContext(scope, 3))).toMatchObject({ readOnly: true });
    const context = createShellPathContext(scope);
    expect(await classifyReadOnlyShellCommand(`cat ${root}/src/a.ts docs/MASTER-PLAN.md`, context)).toMatchObject({ readOnly: true, programs: ['cat'] });
    expect(context.examined).toEqual(['src/a.ts', 'docs/MASTER-PLAN.md']);
  });

  // SEC-6 F31: a model-chosen glob was compiled to a backtracking RegExp and tested synchronously before any approval; `*?` × 20 then
  // `!` against a 40-character name is ≈ 1.4e11 backtracking steps. Steps are the primary assertion: the whole expansion runs under an
  // explicit step budget (the hostile glob has ≈ 85 states, so 41 code points cost a few thousand steps) and fails closed when exhausted.
  it('matches a hostile glob in linear steps and fails closed with GLOB_UNSUPPORTED when the step budget is exhausted (F31)', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dn-shell-glob-')); roots.push(base);
    await writeFile(join(base, 'a'.repeat(40)), 'x\n');
    await writeFile(join(base, '.hidden-' + 'a'.repeat(32)), 'x\n');
    const scope = await createWorkspaceScope(base), hostile = `cat ${'*?'.repeat(20)}!`;
    expect(await classifyReadOnlyShellCommand(hostile, createShellPathContext(scope, undefined, [], 20_000))).toMatchObject({ readOnly: false, reasonCode: 'GLOB_EXPANSION' });
    expect(await classifyReadOnlyShellCommand(hostile, createShellPathContext(scope, undefined, [], 500))).toMatchObject({ readOnly: false, reasonCode: 'GLOB_UNSUPPORTED' });
    expect(await classifyReadOnlyShellCommand(`cat ${'*?'.repeat(20)}`, createShellPathContext(scope, undefined, [], 20_000))).toMatchObject({ readOnly: true });
  });

  // Coarse helper only (the steps above are the assertion): before the fix `*?` × 9 took ≈ 2 s and × 10 ≈ 9 s on one 40-character name
  // (each pair ≈ ×4); after it the whole check takes a few milliseconds, so a loaded suite cannot turn this guard red.
  it('answers a hostile glob within the 1s guard under the default budget (F31)', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dn-shell-glob-')); roots.push(base);
    await writeFile(join(base, 'a'.repeat(40)), 'x\n');
    const scope = await createWorkspaceScope(base), started = performance.now();
    expect(await classifyReadOnlyShellCommand(`cat ${'*?'.repeat(10)}!`, createShellPathContext(scope))).toMatchObject({ readOnly: false, reasonCode: 'GLOB_EXPANSION' });
    const ms = performance.now() - started;
    console.info('SEC6_F31_GLOB_GUARD', JSON.stringify({ pairs: 10, ms }));
    expect(ms).toBeLessThan(1_000);
  });

  // The linear matcher keeps sh semantics: `*`/`?` never match a leading dot unless the segment starts with one, brackets (ranges,
  // negation, POSIX classes) match one character, an unterminated `[` is literal, and collating/equivalence forms stay unsupported.
  it('keeps sh glob semantics for dotfiles and bracket expressions (F31)', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dn-shell-glob-')); roots.push(base);
    for (const file of ['a1.txt', 'b2.txt', 'c3.txt', '.dot.txt', '[x.txt', 'd-4.txt']) await writeFile(join(base, file), 'x\n');
    const scope = await createWorkspaceScope(base), context = createShellPathContext(scope);
    const expand = async (glob: string) => {
      const verdict = await classifyReadOnlyShellCommand(`cat ${glob}`, context);
      return verdict.readOnly ? 'ok' : verdict.reasonCode;
    };
    const cases: [string, string][] = [['*.txt', 'ok'], ['?.txt', 'GLOB_EXPANSION'], ['.*.txt', 'ok'], ['[ab]1.txt', 'ok'], ['[!a]1.txt', 'GLOB_EXPANSION'],
      ['[^b]1.txt', 'ok'], ['[a-c][[:digit:]].txt', 'ok'], ['[[:alpha:]]-[0-9].txt', 'ok'], ['[x.txt', 'ok'], ['[.]dot.txt', 'GLOB_EXPANSION'],
      ['[[.a.]]1.txt', 'GLOB_UNSUPPORTED'], ['[[=a=]]1.txt', 'GLOB_UNSUPPORTED'], ['[[:nope:]]1.txt', 'GLOB_UNSUPPORTED'], ['*.TXT', 'GLOB_EXPANSION']];
    const seen: [string, string][] = [];
    for (const [glob] of cases) seen.push([glob, await expand(glob)]);
    expect(seen).toEqual(cases);
  });
});

it('K15B: shell hard-link protection follows registry login inode identities, including glob aliases and late login creation', async () => {
  const { root } = await workspace(), global = join(root, '..', 'custom-global'), credential = join(global, 'headless/logins/codex/auth.json');
  // AG-4 (KG7 F4): the login read deny and the shell's identity paths name the same registry files, today's list.
  const logins = ['codex/auth.json', 'codex/config.toml', 'codex/installation_id', 'claude/.claude.json', 'claude/.claude.json.backup', 'claude/.credentials.json',
    'claude/.oauth_refresh.lock', 'claude/.oauth_refresh.lock.owner'].map(name => `headless/logins/${name}`);
  expect(DEFAULT_WORKSPACE_READ_DENY.filter(pattern => pattern.includes('headless/logins/'))).toEqual(logins.map(name => `**/${name}`));
  expect(agentLoginIdentityPaths([global, root])).toEqual([global, root].flatMap(each => logins.map(name => join(each, name))));
  const check = await createShellGlobalStateCheck(root, [global], {}, agentLoginIdentityPaths([global]));
  await mkdir(join(credential, '..'), { recursive: true }); await writeFile(credential, 'SYNTHETIC-IDENTITY');
  await link(credential, join(root, 'identity-alias'));
  await writeFile(join(root, 'same-content'), 'SYNTHETIC-IDENTITY');
  await link(join(root, 'same-content'), join(root, 'package-alias'));
  for (const path of ['identity-alias', 'identity-*']) expect(await check(path), path).toBe(true);
  for (const path of ['same-content', 'package-alias', 'package-*']) expect(await check(path), path).toBe(false);
});

it('K15C: host unresolved warning depends on an existing global root; static paths and ordinary host commands remain', async () => {
  const { root } = await workspace(), global = join(root, 'absent-global');
  expect(await hostGlobalStateUnresolved('cd src && cat a.ts', [global])).toBe(false);
  await mkdir(global);
  for (const command of ['cd src && cat a.ts', 'pushd src', 'popd', 'cat "$X/file"', 'cat "${X:-src}/file"', 'cat `pwd`/file',
    'cat $(pwd)/file', 'find . -name x', 'printf x | xargs cat', 'cat <(pwd)', 'cat "unterminated',
    '(cd src && cat a.ts)', 'cd</dev/null src; cat a.ts', 'cat ~+/file', 'cat ~other/file', 'cat src/{a,b}.ts']) {
    expect(await hostGlobalStateUnresolved(command, [global]), command).toBe(true);
  }
  for (const command of ['cat src/a.ts', 'printf API_HOST_STILL_WORKS', 'pwd']) expect(await hostGlobalStateUnresolved(command, [global]), command).toBe(false);
});

it('K15: global root names cover HOME, traversal, globs, aliases and absent children without opening contents', async () => {
  const { root } = await workspace(), base = join(root, '..'), home = join(base, 'home'), global = join(home, '.deckent');
  await mkdir(join(global, 'headless/logins/fixture'), { recursive: true });
  await symlink(global, join(root, 'state-link'));
  await symlink(join(global, 'headless'), join(root, 'deep-state-link'));
  const check = await createShellGlobalStateCheck(root, [global, join(root, 'new-global')], { HOME: home, DECKENT_GLOBAL_HOME: global });
  // SHELL keeps the current variable grammar, including brace forms, assignment removal and token boundaries.
  for (const name of ['${DECKENT_GLOBAL_HOME}/new', 'target=$HOME/.deckent/new', 'target=${DECKENT_GLOBAL_HOME}/new']) expect(await check(name), name).toBe(true);
  for (const name of ['$HOME_SUFFIX/.deckent/new', '${HOME_SUFFIX}/.deckent/new', '$DECKENT_HOME/new']) expect(await check(name), name).toBe(false);
  for (const name of [global, `${global}/headless/logins/fixture/auth.json`, '~/.deckent/headless/*/auth.json', '$HOME/.deckent/new',
    '${HOME}/.deckent/new', '$DECKENT_GLOBAL_HOME/new', '../home/.deckent/new', 'state-link/new/deeper', 'deep-state-link/../new',
    '../home/.deck*/headless/*/auth.json', '../*/.deckent/headless/*/auth.json', `${global}/../.deckent/missing`, 'new-global/new', `if=${global}/headless/logins/fixture/auth.json`]) {
    expect(await check(name), name).toBe(true);
  }
  for (const name of ['src/a.ts', '../outside/secret', '../home/.deckent-other/auth.json', 'new-global-other/new', '[', '[[']) expect(await check(name), name).toBe(false);
});
