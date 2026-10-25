import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ErrorRegistry } from '#platform/index.js';
import { main } from '#surfaces/index.js';

const digest = 'a'.repeat(64);
const result = { schemaVersion: 1, status: 'installed', transactionId: 'choice', planDigest: 'b'.repeat(64),
  proposalDigest: digest, profile: { id: 'fixture', version: '1', digest: 'c'.repeat(64) }, paths: {},
  trust: { mode: 'operator-custom', publisherVerification: 'unverified' } } as never;

it('delegates explicit apply choices unchanged after surface validation', async () => {
  const calls: unknown[][] = [], output: string[] = [];
  expect(await main(['init', 'apply', '--profile', '/input/profile.json', '--docker-executable', '/usr/bin/docker', '--proposal', digest,
    '--accept-custom', '--allow-shutdown', '--json', '--lang', 'en'], { root: '/project', env: {},
    stdout: { write(value: string) { output.push(value); } },
    async applyInstallation(...args) { calls.push(args); return result; },
  })).toBe(0);
  expect(calls).toEqual([['/project', { profilePath: '/input/profile.json', dockerExecutable: '/usr/bin/docker', proposalDigest: digest,
    acceptCustom: true, allowShutdown: true }]]);
  expect(JSON.parse(output.join(''))).toMatchObject({ status: 'installed', proposalDigest: digest });
});

it('never invokes apply without every explicit consent, proposal, and absolute control choice', async () => {
  let calls = 0;
  const context = { root: '/project', env: {}, async applyInstallation() { calls++; return result; } };
  for (const argv of [
    ['init', 'apply', '--profile', '/profile', '--docker-executable', '/usr/bin/docker', '--proposal', digest],
    ['init', 'apply', '--profile', '/profile', '--docker-executable', '/usr/bin/docker', '--accept-custom'],
    ['init', 'apply', '--profile', '/profile', '--proposal', digest, '--accept-custom'],
    ['init', 'apply', '--profile', '/profile', '--docker-executable', 'docker', '--proposal', digest, '--accept-custom'],
    ['init', 'apply', '--profile', '/profile', '--docker-executable', '/usr/bin/docker', '--proposal', digest, '--accept-custom', '--accept-custom'],
    ['init', 'apply', '--profile', '/profile', '--docker-executable', '/usr/bin/docker', '--proposal', digest, '--accept-custom', '--unknown'],
  ]) expect(await main(argv, context)).toBe(2);
  expect(calls).toBe(0);
});

it('resumes only with fresh explicit choices and never forwards a profile', async () => {
  const calls: unknown[][] = [], output: string[] = [], locales: string[] = [];
  expect(await main(['init', 'resume', '--docker-executable', '/usr/bin/docker', '--proposal', digest, '--accept-custom', '--json', '--lang', 'tr'], {
    root: '/project', env: {}, onLocale(locale) { locales.push(locale); }, stdout: { write(value: string) { output.push(value); } },
    async resumeInstallation(...args) { calls.push(args); return result; },
  })).toBe(0);
  expect(calls).toEqual([['/project', { dockerExecutable: '/usr/bin/docker', proposalDigest: digest, acceptCustom: true, allowShutdown: false }]]);
  expect(JSON.parse(output.join(''))).toMatchObject({ status: 'installed' });
  expect(locales).toEqual(['tr']);

  let incompleteCalls = 0;
  expect(await main(['init', 'resume', '--docker-executable', '/usr/bin/docker', '--proposal', digest], {
    root: '/project', env: {}, async resumeInstallation() { incompleteCalls++; return result; },
  })).toBe(2);
  expect(incompleteCalls).toBe(0);
  expect(await main(['init', 'resume', '--profile', '/forbidden-profile', '--docker-executable', '/usr/bin/docker',
    '--proposal', digest, '--accept-custom'], { root: '/project', env: {}, async resumeInstallation() { throw new Error('must not run'); } })).toBe(2);
});

it('bare init identity observes a healthy installation without recovery, while a relocated identity keeps its refusal', async ({ onTestFinished }) => {
  const root = await mkdtemp(join(tmpdir(), 'f1-install-cli-')); onTestFinished(() => rm(root, { recursive: true, force: true }));
  const output: string[] = [], errors: string[] = [];
  const base = { root, env: { DECKENT_GLOBAL_HOME: join(root, 'global') }, locale: 'en' as const, stdout: { write: (s: string) => { output.push(s); } }, stderr: { write: (s: string) => { errors.push(s); } } };
  const loadInstallationIdentity = async () => ({ status: 'available' as const, value: { installationId: 'installation-fixture' } });
  expect(await main(['init', 'identity'], { ...base, loadInstallationIdentity } as never)).toBe(0);
  expect(output.join('')).toContain('healthy (installation-fixture)'); expect(output.join('')).not.toContain('stopped');
  expect(await main(['init', 'identity'], { ...base, loadInstallationIdentity: async () => { throw ErrorRegistry.createError('INSTALLATION_IDENTITY_RELOCATED'); } })).toBe(78);
  expect(errors.join('')).toContain('INSTALLATION_IDENTITY_RELOCATED');
});
it('an existing registry preview is informational but apply keeps its refusal after the terminal gate', async ({ onTestFinished }) => {
  const root = await mkdtemp(join(tmpdir(), 'f1-install-cli-')); onTestFinished(() => rm(root, { recursive: true, force: true }));
  const output: string[] = [], errors: string[] = [];
  const context = { root, env: { DECKENT_GLOBAL_HOME: join(root, 'global') }, locale: 'en' as const, stdin: { isTTY: true } as never,
    stdout: { isTTY: true, write: (s: string) => { output.push(s); } }, stderr: { write: (s: string) => { errors.push(s); } },
    initializeNativeCodingRegistry: async () => { throw ErrorRegistry.createError('INITIAL_REGISTRY_EXISTS'); } };
  const argv = ['init', 'registry', '--scope', 's', '--provider', 'claude', '--kind', 'feature', '--pool', 'p', '--execution-slots', '2', '--in-flight-slots', '2'];
  expect(await main([...argv, '--preview'], context)).toBe(0); expect(output.join('')).toContain('deckent config get admission');
  expect(await main([...argv, '--apply'], context)).toBe(78); expect(errors.join('')).toContain('INITIAL_REGISTRY_EXISTS');
});
