import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { expect, it } from 'vitest';
import { createEncryptedFileSecretStore } from '#adapters/core/secret-store/index.js';
import { SIWC_PROTOCOL } from '#adapters/core/provider-siwc/index.js';
import { DRIVER, type Step } from './contracts/support/pty-steps.js';

const execute = promisify(execFile);
const program = resolve('tests/f1-feasibility-terminal.fixture.mjs');
const name = `${SIWC_PROTOCOL.connectionSecretPrefix}A1000000000040008000000000000002`;
const refusal = 'Personal local custody is unverified. Disconnect the connection; do not move its session records by changing stores.';
const connect = [['Chat only, when I type', '\r'], ['keep automatic API continuation off', '\r', 'next']] as const;
const confirm = [['Cancel', '\u001b[B\r']] as const;

async function seed() {
  const base = await mkdtemp(join(tmpdir(), 'f1-terminal-'));
  const project = join(base, 'project'), home = join(base, 'home'), root = join(home, 'global');
  await mkdir(project, { mode: 0o700 });
  await mkdir(home, { mode: 0o700 });
  const env = { PATH: process.env['PATH'] ?? '', HOME: home, TERM: 'xterm-256color', NO_COLOR: '1' };
  const run = async (mode: string, steps: readonly Step[] = []) => {
    const { stdout } = await execute('python3', ['-c', DRIVER, JSON.stringify([process.execPath, program, mode]), JSON.stringify(steps), 'tty', 'until-exit'],
      { cwd: project, env, timeout: 85_000, maxBuffer: 4 * 1024 * 1024 });
    const result = JSON.parse(stdout) as { status?: number; timeout?: string; output: string };
    const output = stripVTControlCharacters(result.output).replace(/[│╭╮╰╯─]/gu, ' ').replace(/\s+/gu, ' ');
    expect(result.timeout, output).toBeUndefined();
    console.log(`PTY ${mode} exit ${result.status} ${output.match(/FIXTURE_REFUSAL [^ ]+ [^ ]+/u)?.[0] ?? ''} ${output.match(/FIXTURE_EFFECTS \d+ \d+ \d+/u)?.[0] ?? ''}`);
    return { status: result.status, output };
  };
  const seeded = await run('seed');
  expect(seeded.status, seeded.output).toBe(0);
  expect(seeded.output).toContain('FIXTURE_SEEDED_ATTESTED');
  const store = createEncryptedFileSecretStore({ root, platform: 'linux' });
  const snapshot = async () => ({
    binding: await readFile(join(root, 'personal-store-binding.v1.json'), 'utf8'),
    envelope: await readFile(join(root, 'secrets.sealed.json'), 'utf8'),
    record: JSON.parse((await store.get(name))!), names: await store.listNames(),
  });
  const before = await snapshot();
  expect(before.record).toMatchObject({ state: 'connected', generation: 4, tokens: { refreshToken: 'made-up-refresh' } });
  return { run, snapshot, before };
}

function refused(result: { status?: number | undefined; output: string }) {
  expect(result.status, result.output).toBeGreaterThan(0);
  expect(result.output).toContain(refusal);
  expect(result.output).toContain('FIXTURE_REFUSAL SIWC_STORE_NOT_PERSONAL binding-changed');
  expect(result.output).toContain('FIXTURE_EFFECTS 0 0 0');
  expect(result.output).not.toContain('FIXTURE_BROWSER_REACHED');
  expect(result.output).not.toContain('open this sign-in link');
}

it('the witnessed connect reaches personal custody and leaves the retained binding and session untouched', async () => {
  const fixture = await seed();
  refused(await fixture.run('connect', connect));
  expect(await fixture.snapshot()).toEqual(fixture.before);
}, 120_000);

it('logout clears the old record but keeps the binding, so a witnessed connect still fails', async () => {
  const fixture = await seed();
  const disconnected = await fixture.run('logout', confirm);
  expect(disconnected.status, disconnected.output).toBe(0);
  expect(disconnected.output).toContain('Remote revocation was not confirmed. Remove deckent in ChatGPT Settings → Security → Sign in with ChatGPT.');
  expect(disconnected.output).toMatch(/FIXTURE_EFFECTS [1-9]\d* [1-9]\d* 1/u);
  expect(disconnected.output).not.toContain('FIXTURE_BROWSER_REACHED');
  const after = await fixture.snapshot();
  expect(after.binding).toBe(fixture.before.binding);
  expect(after.envelope).not.toBe(fixture.before.envelope);
  expect(after.names).toEqual(fixture.before.names);
  expect(after.record).toEqual({ ...fixture.before.record, state: 'disconnected', tokens: null, generation: 6, remoteRevocation: 'unconfirmed' });
  refused(await fixture.run('connect', connect));
  expect(await fixture.snapshot()).toEqual(after);
}, 120_000);

it('standalone ChatGPT login is refused both with and without an explicit connection ID', async () => {
  const fixture = await seed();
  refused(await fixture.run('login', confirm));
  refused(await fixture.run('login-by-id', confirm));
  expect(await fixture.snapshot()).toEqual(fixture.before);
}, 120_000);
