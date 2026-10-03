import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentTurnWriteFloor, buildLandlockRules, createWorkspaceScope, landlockShellSandbox } from '#adapters/index.js';
import { bubblewrapShellSandbox, resolveBubblewrapView } from '#adapters/core/shell-sandbox-bwrap/index.js';
import { measureTestShellHost } from '../../fixtures/shell-host.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(selfSource = true) {
  const root = await mkdtemp(join(tmpdir(), 'self-source-sandbox-')); roots.push(root);
  for (const dir of ['src', 'dist', 'scripts', 'assets', 'docs', '.github']) {
    await mkdir(join(root, dir)); await writeFile(join(root, dir, 'a'), 'before\n');
  }
  await writeFile(join(root, 'package.json'), '{}');
  const project = await createWorkspaceScope(root);
  return { root, project, scratchDir: null, writeFloor: agentTurnWriteFloor(() => false, false, selfSource) };
}

const capabilities = await measureTestShellHost();
console.info('self-source shell capabilities:', JSON.stringify(capabilities));

describe('derived self-source floor in both shipped shell providers', () => {
  it('binds source trees read-only in bubblewrap and removes write grants in Landlock, customer trees stay writable', async () => {
    for (const selfSource of [true, false]) {
      const f = await fixture(selfSource), view = await resolveBubblewrapView(f, { PATH: '/usr/bin:/bin' }, {}, { floorReadOnly: true });
      const rules = await buildLandlockRules(f, {}, undefined, { floorReadOnly: true });
      if (!view.ok || !rules.ok) throw new Error('view unavailable');
      for (const dir of ['src', 'dist', 'scripts', 'assets']) {
        expect(view.view.readOnlyPaths.includes(join(f.root, dir))).toBe(selfSource);
        const grants = rules.rules.filter(([, path]) => path === '.' || path === dir || path.startsWith(`${dir}/`));
        expect(grants.some(([access]) => access === 'w')).toBe(!selfSource);
      }
      for (const path of ['package.json', '.github']) {
        expect(view.view.readOnlyPaths.includes(join(f.root, path)), path).toBe(true);
        expect(rules.rules.some(([access, grant]) => access === 'w' && (grant === path || grant.startsWith(`${path}/`))), path).toBe(false);
      }
      expect(rules.rules.some(([access, path]) => access === 'w' && (path === 'docs' || path === '.'))).toBe(true);
    }
  });
  for (const provider of ['bubblewrap', 'landlock'] as const) {
    const supported = provider === 'bubblewrap' ? capabilities.bubblewrap.status === 'available' && capabilities.userNamespace === 'available'
      : capabilities.landlock.status === 'available' && (capabilities.landlock.abi ?? 0) >= 6;
    it.skipIf(!supported)(`${provider} refuses existing and new dist writes at the real shell boundary`, async () => {
      const f = await fixture(), sandbox = provider === 'bubblewrap' ? bubblewrapShellSandbox(f) : landlockShellSandbox(f), usable = sandbox.usable(capabilities);
      if (!usable.ok) throw new Error(usable.reason);
      const ran = await usable.realm.run({ command: 'cat dist/a; echo changed >> dist/a; echo new > dist/new; echo written >> docs/a', cwd: f.root,
        environment: { PATH: '/usr/bin:/bin' }, timeoutMs: 20_000, writeFloorReadOnly: true });
      expect(ran.output).toContain('before');
      expect(await readFile(join(f.root, 'dist', 'a'), 'utf8')).toBe('before\n');
      expect(existsSync(join(f.root, 'dist', 'new'))).toBe(false);
      expect(await readFile(join(f.root, 'docs', 'a'), 'utf8')).toBe('before\nwritten\n');
    });
  }
});
