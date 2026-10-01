import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// vitest.config.ts gives every test process gc/maintenance-off Git config (GIT_CONFIG_COUNT) so fixture `git commit`s start no detached
// background maintenance that races with the afterEach directory removal (CI-FIX-2 C3 class, Git 2.55). This pins the mechanism and its limit.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const read = (cwd: string, key: string, env: NodeJS.ProcessEnv) => { try { return execFileSync('git', ['config', '--get', key], { cwd, env, encoding: 'utf8' }).trim(); } catch { return null; } };

describe('test-process git environment', () => {
  it('a fixture repository sees maintenance off, even over its own repository config', () => {
    const root = mkdtempSync(join(tmpdir(), 'deckent-git-env-')); roots.push(root);
    execFileSync('git', ['init', '-q', root]); execFileSync('git', ['-C', root, 'config', 'gc.auto', '6700']);
    expect(read(root, 'gc.auto', process.env)).toBe('0');
    expect(read(root, 'gc.autoDetach', process.env)).toBe('false');
    expect(read(root, 'maintenance.auto', process.env)).toBe('false');
  });
  it('is a property of the test environment only: an explicit child environment (as the product builds one) does not carry it', () => {
    const root = mkdtempSync(join(tmpdir(), 'deckent-git-env-')); roots.push(root);
    execFileSync('git', ['init', '-q', root]); execFileSync('git', ['-C', root, 'config', 'gc.auto', '6700']);
    const explicit = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
    expect(read(root, 'gc.auto', explicit)).toBe('6700');
    expect(read(root, 'maintenance.auto', explicit)).toBeNull();
  });
});
