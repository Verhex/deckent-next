import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { getConfigFieldDefault } from '#platform/index.js';
import { applyInstallation, inspectInstallation } from '../../../src/index.js';
import { lastJson, runInTerminal } from '../support/terminal-cli.js';
import { fixture, rehash, unsupported } from './installation-apply-process.fixture.js';


it.skipIf(unsupported)('rejects a changed proposal or absent custom consent before publishing a target', async () => {
  const changed = await fixture();
  await expect(applyInstallation(changed.project, changed.profile, { allowShutdown: false, dockerExecutable: '/usr/bin/docker',
    proposalDigest: '0'.repeat(64), acceptCustom: true })).rejects.toMatchObject({ code: 'INSTALLATION_PUBLICATION_CHANGED' });
  await expect(readFile(join(changed.project, '.deckent/config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(join(changed.data, 'policy.json'))).rejects.toMatchObject({ code: 'ENOENT' });

  const noConsent = await fixture();
  await expect(noConsent.run(['init', 'apply', '--profile', noConsent.profilePath, '--docker-executable', '/usr/bin/docker',
    '--proposal', '0'.repeat(64), '--json'])).rejects.toMatchObject({ code: 2, stdout: '', stderr: expect.stringContaining('CLI_USAGE') });
  await expect(readFile(join(noConsent.project, '.deckent/config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(join(noConsent.data, 'policy.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.skipIf(unsupported)('refuses marked supplied apply on a real terminal before publication', async () => {
  const marker = 'DECKENT_TEST_INSTALL_OPERATOR', defaultMarker = getConfigFieldDefault('cli').agentEnvironment[0]!;
  const cli = resolve('dist/composition/core/cli/internal/entry.js'), sdk = resolve('dist/index.js');
  const dockerExecutable = '/usr/bin/docker', execute = promisify(execFile);
  for (const surface of ['cli', 'sdk'] as const) {
    const f = await fixture();
    // Wildcard tool coverage cannot be proved within the template on the SDK route.
    f.profile.policy.grants.push({ ...f.profile.policy.grants[0]!, id: 'edit', actions: ['invoke'],
      resource: { kind: 'agent-tool', ids: surface === 'cli' ? ['edit_file'] : 'all' } });
    Object.assign(f.profile.configuration, { cli: { agentEnvironment: [] } });
    await writeFile(f.profilePath, JSON.stringify(rehash(f.profile)));
    const env = { HOME: join(f.root, 'home'), PATH: '/usr/bin:/bin', DECKENT_LANGUAGE: 'en' };
    const marked = { ...env, [surface === 'cli' ? marker : defaultMarker]: '1' };
    if (surface === 'cli') {
      // Only the settled project setting names this marker. The supplied profile names none.
      await mkdir(join(f.project, '.deckent'), { mode: 0o700 });
      await writeFile(join(f.project, '.deckent/config.json'), JSON.stringify({ cli: { agentEnvironment: [marker] } }), { mode: 0o600 });
    }
    const before = await readdir(f.project, { recursive: true });
    const config = join(f.project, '.deckent/config.json');
    const settings = surface === 'cli' ? await readFile(config) : null;
    const { proposalDigest } = await inspectInstallation(f.project, f.profile, { allowShutdown: false, dockerExecutable });
    const command = surface === 'cli'
      ? [cli, 'init', 'apply', '--profile', f.profilePath, '--docker-executable', dockerExecutable, '--proposal', proposalDigest, '--accept-custom', '--json']
      : ['--input-type=module', '-e', `
        import { readFile } from 'node:fs/promises';
        import { applyInstallation } from ${JSON.stringify(sdk)};
        const [profile, dockerExecutable, proposalDigest] = process.argv.slice(1);
        try {
          const result = await applyInstallation(process.cwd(), JSON.parse(await readFile(profile)), { allowShutdown: false, dockerExecutable, proposalDigest, acceptCustom: true });
          console.log(JSON.stringify({ status: result.status, proposalDigest: result.proposalDigest }));
        }
        catch (error) { console.log(JSON.stringify({ code: error.code })); process.exitCode = 1; }
      `, f.profilePath, dockerExecutable, proposalDigest];
    const result = await runInTerminal([process.execPath, ...command], f.project, marked);
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toContain('AUTHORITY_WITNESS_REQUIRED');
    expect(await readdir(f.project, { recursive: true })).toEqual(before);
    await expect(readdir(f.data)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readdir(env.HOME)).rejects.toMatchObject({ code: 'ENOENT' });
    if (settings) expect(await readFile(config)).toEqual(settings);
    if (surface === 'sdk') {
      await expect(execute(process.execPath, command, { cwd: f.project, env, timeout: 30_000 }))
        .rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('AUTHORITY_WITNESS_REQUIRED') });
      expect(await readdir(f.project, { recursive: true })).toEqual(before);
      await expect(readdir(f.data)).rejects.toMatchObject({ code: 'ENOENT' });

      const witnessed = await runInTerminal([process.execPath, ...command], f.project, env);
      expect(witnessed.code, witnessed.output).toBe(0);
      expect(lastJson(witnessed.output)).toMatchObject({ status: 'installed', proposalDigest });
    }
  }

  const baseline = await fixture();
  const { stdout } = await execute(process.execPath, [cli, 'init', 'policy', '--scope', 'installation', '--apply', '--json'],
    { cwd: baseline.project, env: { HOME: join(baseline.root, 'home'), PATH: '/usr/bin:/bin', [defaultMarker]: '1' }, timeout: 30_000 });
  expect(JSON.parse(stdout)).toMatchObject({ status: 'installed' });

  const within = await fixture();
  const evidence = await inspectInstallation(within.project, within.profile, { allowShutdown: false, dockerExecutable });
  const installed = await applyInstallation(within.project, within.profile,
    { allowShutdown: false, dockerExecutable, proposalDigest: evidence.proposalDigest, acceptCustom: true });
  expect(installed).toMatchObject({ status: 'installed', proposalDigest: evidence.proposalDigest });
}, 90_000);
