import { mkdir, mkdtemp, rm, symlink, writeFile, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createShellPathContext, createWorkspaceScope } from '#adapters/index.js';
import { classifyReadOnlyShellCommand, classifyShellMutation, classifyShellRisk, shellPermissionTier } from '#engine/index.js';
import { createShellWriteContext } from '#composition/core/agent-turn/index.js';

// T-L4 slice 4a, owner q1: the narrow mutating tier is a separate classifier layer — recognized programs, checked paths, inside the
// workspace — and the always-ask floor (interpreters, privilege, eval, xargs, tee, package managers, network, malformed input,
// PowerShell) is decided first. The tier is asked on real files through the same scope and write floor as agent edits.
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));
async function workspace() {
  const base = await mkdtemp(join(tmpdir(), 'dn-shell-mutation-')); roots.push(base);
  const root = join(base, 'project'), outside = join(base, 'outside');
  for (const dir of ['src', 'out', '.github', '.git']) await mkdir(join(root, dir), { recursive: true });
  await mkdir(outside);
  for (const file of ['src/a.ts', 'notes.md', 'readme.md', '.env', 'package.json']) await writeFile(join(root, file), 'x\n');
  await writeFile(join(outside, 'secret'), 'outside\n');
  await symlink(join(outside, 'secret'), join(root, 'to-outside'));
  await symlink(outside, join(root, 'linked-dir'));
  await link(join(root, 'notes.md'), join(root, 'hard.md'));
  const scope = await createWorkspaceScope(root);
  const tier = async (command: string, dialect: 'posix' | 'powershell' = 'posix') => {
    const paths = createShellPathContext(scope);
    const readOnly = await classifyReadOnlyShellCommand(command, paths, dialect);
    const mutation = await classifyShellMutation(command, paths, createShellWriteContext(scope), dialect);
    return { mutation, tier: shellPermissionTier(classifyShellRisk(command, readOnly), readOnly, mutation) };
  };
  return { root, tier };
}

describe.skipIf(process.platform !== 'linux')('narrow mutating shell tier (T-L4 slice 4a)', () => {
  it('recognizes mkdir, touch, cp and mv on checked workspace paths', async () => {
    const { tier } = await workspace();
    for (const command of ['touch new.txt', 'touch src/a.ts', 'touch -c src/b.ts', 'mkdir build', 'mkdir -p out/sub', 'cp src/a.ts copy.ts', 'cp -n src/a.ts out/a.ts',
      'mv readme.md docs.md', 'mv -v src/a.ts out/a.ts', 'mkdir tmp && touch new.txt', 'touch x.txt; touch y.txt', 'touch -- new.txt', 'touch ./z.txt']) {
      expect({ command, ...(await tier(command)) }).toMatchObject({ command, mutation: { tier: 'narrow' }, tier: 'narrow-mutating' });
    }
  });

  it('keeps the always-ask floor above the narrow set, whatever else the command holds', async () => {
    const { tier } = await workspace();
    for (const [command, reasonCode] of [['python3 -c 1', 'INTERPRETER'], ['bash -c "touch a"', 'INTERPRETER'], ['sudo touch a', 'PRIVILEGE_ESCALATION'],
      ['eval touch a', 'EVAL'], ['touch a && xargs rm', 'XARGS'], ['touch a; tee b', 'OUTPUT_TEE'], ['npm install left-pad', 'PACKAGE_MANAGER'],
      ['pip install x', 'PACKAGE_MANAGER'], ['curl http://x', 'NETWORK_TOOL'], ['touch a && wget http://x', 'NETWORK_TOOL'], ['ssh host', 'NETWORK_TOOL'],
      ['touch $HOME/a', 'VARIABLE_EXPANSION'], ['touch `id`', 'COMMAND_SUBSTITUTION'], ['touch a > b', 'OUTPUT_REDIRECTION'], ['touch "a', 'UNPARSEABLE'],
      ['touch a &', 'BACKGROUND_JOB'], ['X=1 touch a', 'ENV_ASSIGNMENT'], ['./tool', 'PROGRAM_PATH'], ['(touch a)', 'SUBSHELL']] as const) {
      expect({ command, ...(await tier(command)) }).toMatchObject({ command, mutation: { tier: 'always-ask', reasonCode }, tier: 'always-ask' });
    }
    expect(await tier('New-Item a', 'powershell')).toMatchObject({ mutation: { tier: 'always-ask', reasonCode: 'UNSUPPORTED_DIALECT' }, tier: 'always-ask' });
  });

  it('is not narrow on the write floor, a denied, outside, linked, globbed or dot-dot path, an unknown option or program, or a pipe', async () => {
    const { tier } = await workspace();
    for (const command of ['touch package.json', 'touch .github/ci.yml', 'mkdir .github', 'mkdir .claude', 'cp src/a.ts Makefile', 'mv readme.md .deckent/x',
      'touch .env', 'cp .env copy', 'touch .git/x', 'touch ../escape', 'touch /tmp/x', 'touch to-outside', 'touch linked-dir/x', 'cp src/a.ts linked-dir/x',
      'cp src/a.ts out', 'mv readme.md out', 'mv notes.md moved.md', 'touch hard.md', 'touch src/*.ts', 'touch ~/x', 'touch src/../new', 'touch -d yesterday a', 'cp -r src dst',
      'mv -f readme.md x', 'mkdir -m 777 d', 'mkdir src', 'mv missing.md x', 'mkdir a/b/c', 'cp a b c', 'touch a | cat', 'ln -s src/a.ts l', 'sed -i s/a/b/ src/a.ts',
      'git add .', 'rm src/a.ts', 'chmod 600 src/a.ts', 'touch -- -n']) {
      expect({ command, ...(await tier(command)) }).toMatchObject({ command, tier: 'other-modify' });
    }
  });

  it('never demotes destructive, and keeps read-only tiers as the read classifier set them', async () => {
    const { tier } = await workspace();
    for (const command of ['rm -rf src', 'rm -f notes.md', 'touch a && rm -rf src', 'git reset --hard', 'truncate -s 0 notes.md', 'mkdir x; rmdir x']) {
      expect({ command, ...(await tier(command)) }).toMatchObject({ command, tier: 'destructive' });
    }
    expect(await tier('cat src/a.ts')).toMatchObject({ tier: 'read-none' });
    for (const command of ['find .', 'grep -r x .', 'git log -p']) expect({ command, ...(await tier(command)) }).toMatchObject({ command, tier: 'read-low' });
  });
});
