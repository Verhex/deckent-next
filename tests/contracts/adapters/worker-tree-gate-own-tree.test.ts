import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { scanWorkerTree } from '#adapters/index.js';
import { CORE_SCHEMA } from '#platform/core/config/index.js';

// S6 false positive (N1 wave 8, 2026-10-21): the product's own tracked tree must pass the production worker-tree gate, otherwise every worker on
// a deckent-next checkout is refused (`WORKER_TREE_SECRET_REFUSED`). Same rules and default bounds as production. The only lifts are the operator
// acknowledgements a deckent-next checkout declares by design: test fixtures and the message catalogs (prose under secret-like keys, e.g.
// "config.secretMissing") by glob, and the settings-only `.npmrc` by exact path. Product source and configuration are never lifted.
const exec = promisify(execFile), repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('the worker-tree gate over this repository', () => {
  it('refuses nothing in the tracked source tree with the production defaults', async () => {
    const { stdout } = await exec('git', ['-C', repo, 'ls-files', '-z'], { maxBuffer: 64 << 20 });
    const root = await mkdtemp(join(tmpdir(), 'dn-own-tree-')); roots.push(root);
    for (const path of stdout.split('\0').filter(Boolean)) { await mkdir(dirname(join(root, path)), { recursive: true }); await cp(join(repo, path), join(root, path), { verbatimSymlinks: true }).catch(() => undefined); }
    const docker = { executable: 'docker', imageId: `sha256:${'a'.repeat(64)}`, memoryBytes: 1, pids: 1, cpus: 1, logMaxSizeKiB: 1, logMaxFiles: 1, tmpBytes: 1, deadlineMs: 1, controlTimeoutMs: 1, outputBytes: 1 };
    const settings = (CORE_SCHEMA.parse({ execution: { docker, git: { gitExecutable: 'git', timeoutMs: 1 } } }) as { execution: { secretGate: { allowPatternPaths: string[]; acknowledgedDenyPaths: string[];
      maxFiles: number; maxFileBytes: number; maxTotalBytes: number; timeoutMs: number } } }).execution.secretGate;
    const scan = await scanWorkerTree(root, { ...settings, allowPatternPaths: ['tests/**', '.agents/**', 'src/platform/core/i18n/locales/**'], acknowledgedDenyPaths: ['.npmrc'] });
    expect(scan.status === 'refused' ? scan.findings : scan.status).toEqual(scan.status === 'refused' ? [] : 'clean');
  }, 180_000);
});
