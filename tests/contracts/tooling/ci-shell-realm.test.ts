import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
// @ts-expect-error JavaScript CI tooling has no declaration file.
import { inspectCiShellRealmProject } from '../../../scripts/ci-shell-realm.mjs';

const cli = fileURLToPath(new URL('../../../dist/composition/core/cli/internal/entry.js', import.meta.url));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ci-realm-proof-')); roots.push(root);
  const home = join(root, 'home'), global = join(root, 'global'), project = join(root, 'project');
  for (const path of [home, global, project]) mkdirSync(path, { mode: 0o700 });
  return { project, home, global, env: { PATH: process.env['PATH'], HOME: home, USERPROFILE: home,
    DECKENT_GLOBAL_HOME: global, DECKENT_LANGUAGE: 'en', NO_COLOR: '1' } };
}

// Some restricted hosts cannot capture Node children through socket-backed pipes. Capture the
// identical binary/argv in private files; never substitute a command, exit code or JSON result.
function fileCapture(command: string, args: string[], options: ExecFileSyncOptions): string {
  const root = mkdtempSync(join(tmpdir(), 'ci-cli-output-'));
  const out = join(root, 'stdout'), err = join(root, 'stderr');
  const descriptors = [openSync(out, 'wx', 0o600), openSync(err, 'wx', 0o600)];
  let failure: unknown;
  try {
    try { execFileSync(command, args, { ...options, stdio: ['ignore', descriptors[0]!, descriptors[1]!] }); }
    catch (error) { failure = error; }
    for (const path of [out, err]) expect(statSync(path).size).toBeLessThanOrEqual(options.maxBuffer ?? 1_048_576);
    const stdout = readFileSync(out, 'utf8'), stderr = readFileSync(err, 'utf8');
    if (failure) throw Object.assign(failure, { stdout, stderr });
    return stdout;
  } finally { for (const fd of descriptors) closeSync(fd); rmSync(root, { recursive: true, force: true }); }
}

it('prepares a private CI installation for the real doctor without initializing the caller project or using its HOME config', context => {
  if (process.platform !== 'linux') {
    console.log('verify-not-run: CI_REALM_INSTALLATION_LINUX_REQUIRED'); context.skip(); return;
  }
  const f = fixture();
  mkdirSync(join(f.home, '.deckent')); writeFileSync(join(f.home, '.deckent/config.json'), 'invalid caller config');
  const report = inspectCiShellRealmProject(f.env, fileCapture);
  expect(report.startability).toMatchObject({ status: 'ready', checks: [] });
  expect(report.shellRealm.stateDir).toBe(f.global);
  expect(report.paths.home).not.toBe(f.home);
  expect(report.paths.home.startsWith(tmpdir())).toBe(true);
  expect(() => readdirSync(report.paths.home)).toThrow(); // the private installation is removed
  expect(readdirSync(f.project)).toEqual([]);
  expect(readFileSync(join(f.home, '.deckent/config.json'), 'utf8')).toBe('invalid caller config');
});

it('keeps the actual doctor nonzero and read-only on an uninitialized project', context => {
  if (process.platform !== 'linux') {
    console.log('verify-not-run: CI_REALM_INSTALLATION_LINUX_REQUIRED'); context.skip(); return;
  }
  const f = fixture();
  let result: { status: number; stdout: string; stderr: string } | undefined;
  try { fileCapture(process.execPath, [cli, 'doctor', '--json'], { cwd: f.project, env: f.env,
    encoding: 'utf8', timeout: 30_000, maxBuffer: 1_048_576 }); }
  catch (error) { result = error as typeof result; }
  expect(result?.status).toBe(78);
  if (!result) throw new Error('doctor unexpectedly succeeded');
  expect(result.stderr).toContain('INSTALLATION_NOT_STARTABLE');
  const report = JSON.parse(result.stdout);
  expect(report.startability.checks.map((check: { code: string }) => check.code)).toEqual(expect.arrayContaining([
    'DOCTOR_CONFIG_INCOMPLETE', 'DOCTOR_LEDGER_UNAVAILABLE', 'DOCTOR_POLICY_UNREADABLE',
  ]));
  expect(readdirSync(f.project)).toEqual([]);
});

it('refuses an unsupported runner global config version instead of bypassing or replacing it', context => {
  if (process.platform !== 'linux') {
    console.log('verify-not-run: CI_REALM_INSTALLATION_LINUX_REQUIRED'); context.skip(); return;
  }
  const f = fixture(), config = join(f.global, 'config.json');
  const unsupported = JSON.stringify({ schema_version: 999 });
  writeFileSync(config, unsupported, { mode: 0o600 });
  let failure: { status: number; stderr: string } | undefined;
  try { inspectCiShellRealmProject(f.env, fileCapture); } catch (error) { failure = error as typeof failure; }
  expect(failure?.status).toBe(78);
  expect(failure?.stderr).toContain('CONFIG');
  expect(readFileSync(config, 'utf8')).toBe(unsupported);
  expect(readdirSync(f.project)).toEqual([]);
});
