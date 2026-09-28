import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { resolveDockerReadOnlyMounts, resolveDockerTaskProfile, validateDockerTaskProfile } from '#adapters/index.js';
import { criterionWithin } from '#capabilities/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const profile = (readOnlyMounts: unknown) => ({ id: 'verify', version: 1, adapter: { id: 'docker', version: 2 }, parameters: {
  argv: ['npm', 'test'], imageId: 'sha256:' + 'a'.repeat(64), memoryBytes: 268435456, pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2,
  tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536, readOnlyMounts } });

it('pins read-only dependency mounts as profile data, apart from the supervisor options', () => {
  const mounts = [{ source: 'node_modules', target: '/node_modules' }, { source: 'tools/python/.venv', target: '/opt/venv' }];
  const resolved = resolveDockerTaskProfile(profile(mounts));
  expect(resolved.readOnlyMounts).toEqual(mounts);
  expect(resolved.options).not.toHaveProperty('readOnlyMounts');
});

it.each([
  ['a parent segment', [{ source: '../outside', target: '/deps' }]],
  ['an absolute host path', [{ source: '/home/user/.ssh', target: '/deps' }]],
  ['the project root itself', [{ source: '.', target: '/deps' }]],
  ['an empty segment', [{ source: 'a//b', target: '/deps' }]],
  ['a Git directory', [{ source: 'sub/.git', target: '/deps' }]],
  ['the product directory', [{ source: '.deckent/live-data', target: '/deps' }]],
  ['a relative target', [{ source: 'node_modules', target: 'node_modules' }]],
  ['the container root', [{ source: 'node_modules', target: '/' }]],
  ['the delivered tree', [{ source: 'node_modules', target: '/workspace' }]],
  ['a target inside the delivered tree', [{ source: 'node_modules', target: '/workspace/node_modules' }]],
  ['a target under tmp', [{ source: 'node_modules', target: '/tmp/deps' }]],
  ['a target over task inputs', [{ source: 'node_modules', target: '/deckent/inputs' }]],
  ['a target under run', [{ source: 'node_modules', target: '/run/deps' }]],
  ['a target under proc', [{ source: 'node_modules', target: '/proc/deps' }]],
  ['a non-normalized target', [{ source: 'node_modules', target: '/deps/../workspace' }]],
  ['duplicate targets', [{ source: 'a', target: '/deps' }, { source: 'b', target: '/deps' }]],
  ['a writable flag', [{ source: 'node_modules', target: '/deps', readonly: false }]],
  ['too many mounts', Array.from({ length: 9 }, (_, index) => ({ source: `d${index}`, target: `/d${index}` }))],
] as const)('rejects %s at profile validation', (_name, mounts) => {
  expect(() => validateDockerTaskProfile(profile(mounts))).toThrow('DOCKER_TASK_PROFILE_INVALID');
});

it('resolves sources inside the real project root and refuses links, files and product data', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'deckent-mounts-'))); roots.push(root);
  const project = join(root, 'project'); const data = join(project, 'state', 'data');
  await mkdir(join(project, 'node_modules', 'dep'), { recursive: true }); await mkdir(data, { recursive: true });
  await mkdir(join(root, 'outside', 'deps'), { recursive: true }); await symlink(join(root, 'outside'), join(project, 'linked'));
  await mkdir(join(project, 'real')); await symlink(join(project, 'real'), join(project, 'inner-link'));
  await writeFile(join(project, 'file'), 'x');
  const excluded = [data, join(root, 'workspaces')];
  expect(await resolveDockerReadOnlyMounts(project, [{ source: 'node_modules', target: '/node_modules' }], excluded))
    .toEqual([{ source: join(project, 'node_modules'), target: '/node_modules' }]);
  // `linked/deps` is a real directory reached through a linked parent: only the real-path comparison refuses it.
  for (const source of ['linked', 'linked/deps', 'inner-link', 'file', 'missing', 'state', 'state/data', 'state/data/x']) {
    if (source === 'state/data/x') await mkdir(join(data, 'x'));
    await expect(resolveDockerReadOnlyMounts(project, [{ source, target: '/deps' }], excluded), source).rejects.toThrow('SUPERVISOR_REQUEST_INVALID');
  }
});

it('compares a verification criterion with the required bar per evaluator implementation (fail-closed for unknown ones)', () => {
  const exit = { id: 'process-exit', version: 1 };
  expect(criterionWithin(exit, { acceptedExitCodes: [0] }, { acceptedExitCodes: [0] })).toBe(true);
  expect(criterionWithin(exit, { acceptedExitCodes: [0, 2] }, { acceptedExitCodes: [2] })).toBe(true);
  expect(criterionWithin(exit, { acceptedExitCodes: [0] }, { acceptedExitCodes: [0, 1] })).toBe(false);
  expect(criterionWithin(exit, { acceptedExitCodes: [0] }, { acceptedExitCodes: [1] })).toBe(false);
  expect(criterionWithin(exit, { acceptedExitCodes: [0] }, { codes: [0] })).toBe(false);
  expect(criterionWithin({ id: 'process-exit', version: 2 }, { acceptedExitCodes: [0] }, { acceptedExitCodes: [0] })).toBe(false);
  expect(criterionWithin({ id: 'erp-test', version: 1 }, {}, {})).toBe(false);
});
