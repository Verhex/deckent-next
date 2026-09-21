import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { prepareNativeCodingProfile } from '#composition/index.js';

const roots: string[] = [];
const cli = resolve('dist/composition/core/cli/internal/entry.js');
const sdk = resolve('dist/index.js');
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'deckent-coding-')); roots.push(root);
  const project = join(root, 'project'); const home = join(root, 'home'); mkdirSync(project); mkdirSync(home);
  return { project, env: { HOME: home, PATH: process.env.PATH } };
}
const input = (provider = 'codex') => ({ schemaVersion: 1, template: { id: 'coding', version: 1,
  adapter: { id: 'docker', version: 2 }, parameters: { argv: ['unused'], imageId: 'sha256:' + 'a'.repeat(64),
    memoryBytes: 268435456, pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2,
    tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 } },
  invocation: { schemaVersion: 1, provider, permissionMode: 'unattended', model: 'configured-model', prompt: '--task; $(not-a-command)' } });

it.each(['codex', 'claude', 'cursor'])('compiled CLI stdin and public SDK prepare the same %s profile without creating project state', provider => {
  const f = fixture(); const request = input(provider);
  const cliResult = spawnSync(process.execPath, [cli, 'coding', 'prepare', '--input', '-', '--json'], {
    cwd: f.project, env: f.env, input: JSON.stringify(request), encoding: 'utf8', timeout: 10000 });
  expect(cliResult.status, cliResult.stderr).toBe(0);
  const sdkResult = spawnSync(process.execPath, ['--input-type=module', '-e',
    'const {prepareNativeCodingProfile}=await import(process.argv[1]); let input=""; for await(const part of process.stdin) input+=part; console.log(JSON.stringify(prepareNativeCodingProfile(JSON.parse(input))));', sdk],
  { cwd: f.project, env: f.env, input: JSON.stringify(request), encoding: 'utf8', timeout: 10000 });
  expect(sdkResult.status, sdkResult.stderr).toBe(0);
  expect(JSON.parse(cliResult.stdout)).toEqual(JSON.parse(sdkResult.stdout));
  expect(JSON.parse(cliResult.stdout).activation).toBe('not-activated');
  expect(readdirSync(f.project)).toEqual([]);
});

it('rejects invalid transport, duplicated flags, unsupported providers and unknown authorization fields', () => {
  const f = fixture();
  for (const [args, body] of [
    [[], '{'],
    [[], JSON.stringify({ ...input(), invocation: { ...input().invocation, provider: 'other' } })],
    [['--input', '-'], JSON.stringify(input())],
  ] as const) {
    const result = spawnSync(process.execPath, [cli, 'coding', 'prepare', '--input', '-', '--json', ...args],
      { cwd: f.project, env: f.env, input: body, encoding: 'utf8', timeout: 10000 });
    expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
  }
  expect(() => prepareNativeCodingProfile({ ...input(), grant: 'all' })).toThrow();
  expect(readdirSync(f.project)).toEqual([]);
});

it('reads a relative Unicode input file with Turkish locale', () => {
  const f = fixture(); const file = 'görev profili.json';
  writeFileSync(join(f.project, file), JSON.stringify(input('claude')));
  const result = spawnSync(process.execPath, [cli, 'coding', 'prepare', '--input', file, '--json', '--lang', 'tr'],
    { cwd: f.project, env: f.env, encoding: 'utf8', timeout: 10000 });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).profile.parameters.argv[0]).toBe('claude');
});
