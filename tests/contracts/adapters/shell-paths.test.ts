import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createShellPathContext, createWorkspaceScope } from '#adapters/index.js';
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
    // Real-filesystem cases the lexical legacy matrix could not show.
    ['cat notes.txt', 'PATH_PROTECTED'], ['cat linked/secret', 'PATH_OUTSIDE_ROOT'], ['cat missing.txt', 'PATH_UNRESOLVED'], ['cat *.nomatch', 'GLOB_EXPANSION'],
    ['wc -l < .env', 'PATH_PROTECTED'], ['grep -f .env src/a.ts', 'PATH_PROTECTED'],
  ])('%s → %s', async (command, reasonCode) => {
    const { scope } = await workspace();
    expect(await classifyReadOnlyShellCommand(command, createShellPathContext(scope)), command).toMatchObject({ readOnly: false, reasonCode });
  });

  it('bounds glob expansion, accepts an absolute path inside the root and reports the examined paths root-relative', async () => {
    const { root, scope } = await workspace();
    expect(await classifyReadOnlyShellCommand('cat src/*.ts', createShellPathContext(scope, 2))).toMatchObject({ readOnly: false, reasonCode: 'GLOB_EXPANSION' });
    expect(await classifyReadOnlyShellCommand('cat src/*.ts', createShellPathContext(scope, 3))).toMatchObject({ readOnly: true });
    const context = createShellPathContext(scope);
    expect(await classifyReadOnlyShellCommand(`cat ${root}/src/a.ts docs/MASTER-PLAN.md`, context)).toMatchObject({ readOnly: true, programs: ['cat'] });
    expect(context.examined).toEqual(['src/a.ts', 'docs/MASTER-PLAN.md']);
  });
});
