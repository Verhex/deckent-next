import { expect, it } from 'vitest';
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
