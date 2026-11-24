import { chmod, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import * as adapters from '#adapters/index.js';
import { immutableJsonObjectSchema } from '#domain/index.js';
import { getConfigFieldDefault, resolveGlobalConfigPaths } from '#platform/index.js';
import { applyInstallation, inspectInstallation, resumeInstallation } from '../../../src/index.js';
import { lastJson, runInTerminal } from '../support/terminal-cli.js';
import { fixture, rehash, unsupported } from './installation-apply-process.fixture.js';


it.skipIf(unsupported || userInfo().uid === 0)('resumes a real pending publication without the external profile after fixing owned directory permissions', async () => {
  const f = await fixture(), control = { allowShutdown: false, dockerExecutable: '/usr/bin/docker' };
  const evidence = await inspectInstallation(f.project, f.profile, control);
  await mkdir(f.data, { mode: 0o700 }); await chmod(f.data, 0o555);
  await expect(applyInstallation(f.project, f.profile, { ...control, proposalDigest: evidence.proposalDigest, acceptCustom: true })).rejects.toBeDefined();

  const journalPath = join(f.project, '.deckent/installation/journal.json');
  const pending = JSON.parse(await readFile(journalPath, 'utf8'));
  expect(pending).toMatchObject({ schemaVersion: 2, phase: 'pending', planDigest: evidence.preview.planDigest,
    profileDigest: f.profile.profile.digest, blockers: ['INSTALLATION_NOT_APPLIED'],
    resources: expect.arrayContaining(['config', 'policy', 'ledger'].map(resource => expect.objectContaining({ resource, state: 'pending' }))),
    recovery: { schemaVersion: 1, material: { authoredProfile: f.profile, allowShutdown: false },
      consent: { mode: 'operator-custom', proposalDigest: evidence.proposalDigest } } });
  expect(pending.transactionId).toBe(pending.recovery.consent.id);
  await expect(readFile(join(f.data, 'policy.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(join(f.data, 'state/ledger.db'))).rejects.toMatchObject({ code: 'ENOENT' });

  await rm(f.profilePath); await chmod(f.data, 0o700);
  const installed = JSON.parse((await f.run(['init', 'resume', '--docker-executable', '/usr/bin/docker', '--proposal', evidence.proposalDigest,
    '--accept-custom', '--json'])).stdout);
  expect(installed).toMatchObject({ status: 'installed', transactionId: pending.transactionId, proposalDigest: evidence.proposalDigest,
    trust: { mode: 'operator-custom', publisherVerification: 'unverified' } });
  expect(JSON.parse(await readFile(journalPath, 'utf8'))).toMatchObject({ transactionId: pending.transactionId, phase: 'committed', blockers: [] });
// Two real installation passes plus a compiled CLI resume: measured 27-31 s on the WSL host (2026-09-25/26), at the 30 s default.
}, 90_000);

it.skipIf(unsupported || userInfo().uid === 0)('preserves a pending widening proposal on marked resume and on evidence drift under the journal lock', async () => {
  const f = await fixture(), dockerExecutable = join(f.root, 'image-probe');
  const cli = resolve('dist/composition/core/cli/internal/entry.js'), sdk = resolve('dist/index.js');
  const env = { HOME: join(f.root, 'home'), PATH: '/usr/bin:/bin', DECKENT_LANGUAGE: 'en' };
  const defaultMarker = getConfigFieldDefault('cli').agentEnvironment[0]!;
  const customMarker = 'DECKENT_TEST_INSTALL_OPERATOR';
  const globalConfig = resolveGlobalConfigPaths(env).platformPath;
  const markerConfig = (agentEnvironment: string[]) => JSON.stringify({ cli: { agentEnvironment } });
  // Only settled global settings name the custom marker; the pending profile names none.
  await mkdir(dirname(globalConfig), { recursive: true, mode: 0o700 });
  await writeFile(globalConfig, markerConfig([defaultMarker, customMarker]), { mode: 0o600 });
  const drift = join(f.root, 'drift');
  const nextGlobalConfig = join(f.root, 'next-global-config');
  // The probe applies fixture changes only while publication holds the real config lock.
  await writeFile(dockerExecutable, `#!/bin/sh
case "$1 $3" in
  'context --format') printf '%s\\n' '{"Host":"unix:///fixture.sock"}' ;;
  '--host info')
    if [ -d "\${0%/*}/project/.deckent/config.json.write-lock" ]; then
      if [ -f "\${0%/*}/next-global-config" ]; then
        mv "\${0%/*}/next-global-config" "$HOME/${relative(env.HOME, globalConfig)}" || exit 2
      fi
      if [ -f "\${0%/*}/drift" ]; then
        printf '%s\\n' fixture-daemon-changed
        exit
      fi
    fi
    printf '%s\\n' fixture-daemon ;;
  '--host image') printf '%s\\n' "$5" ;;
  *) exit 2 ;;
esac
`, { mode: 0o700 });
  f.profile.configuration.execution.docker.executable = dockerExecutable;
  f.profile.policy.grants.push({ ...f.profile.policy.grants[0]!, id: 'edit', actions: ['invoke'], resource: { kind: 'agent-tool', ids: ['edit_file'] } });
  Object.assign(f.profile.configuration, { cli: { agentEnvironment: [] } });
  await writeFile(f.profilePath, JSON.stringify(rehash(f.profile)));
  const { proposalDigest } = await inspectInstallation(f.project, f.profile, { allowShutdown: false, dockerExecutable });
  const sdkRun = (action: 'apply' | 'resume', environment = env) => runInTerminal([process.execPath, '--input-type=module', '-e', `
    import { readFile } from 'node:fs/promises';
    import { applyInstallation, resumeInstallation } from ${JSON.stringify(sdk)};
    const [action, profile, dockerExecutable, proposalDigest] = process.argv.slice(1);
    const choices = { allowShutdown: false, dockerExecutable, proposalDigest, acceptCustom: true };
    try {
      const result = action === 'apply'
        ? await applyInstallation(process.cwd(), JSON.parse(await readFile(profile)), choices)
        : await resumeInstallation(process.cwd(), choices);
      console.log(JSON.stringify({ status: result.status, proposalDigest: result.proposalDigest }));
    }
    catch (error) { console.log(JSON.stringify({ code: error.code })); process.exitCode = 1; }
  `, action, f.profilePath, dockerExecutable, proposalDigest], f.project, environment);
  const resume = (environment: NodeJS.ProcessEnv = env) => runInTerminal([process.execPath, cli, 'init', 'resume', '--docker-executable', dockerExecutable,
    '--proposal', proposalDigest, '--accept-custom', '--json'], f.project, environment);
  await mkdir(f.data, { mode: 0o700 }); await chmod(f.data, 0o555);
  const interrupted = await sdkRun('apply');
  expect(interrupted.code, interrupted.output).toBe(1);
  const journalPath = join(f.project, '.deckent/installation/journal.json');
  const pending = await readFile(journalPath, 'utf8');
  const { transactionId, resources } = JSON.parse(pending) as { transactionId: string; resources: { path: string }[] };
  expect(JSON.parse(pending)).toMatchObject({ phase: 'pending', recovery: { consent: { proposalDigest } },
    resources: expect.arrayContaining(['config', 'policy', 'ledger'].map(resource => expect.objectContaining({ resource, state: 'pending' }))) });
  await chmod(f.data, 0o700);
  const footprint = async () => ({
    journal: await readFile(journalPath, 'utf8'),
    globalConfig: await readFile(globalConfig, 'utf8'),
    targets: await Promise.all(resources.map(({ path }) => readFile(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    }))),
    project: (await readdir(f.project, { recursive: true })).sort(),
    data: (await readdir(f.data, { recursive: true })).sort(),
    home: await readdir(env.HOME, { recursive: true }).then(files => files.sort(), (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    }),
  });
  const before = await footprint();
  for (const marker of [customMarker, defaultMarker]) {
    const marked = { ...env, [marker]: '1' };
    for (const run of [() => sdkRun('resume', marked), () => resume(marked)]) {
      const refused = await run();
      expect(refused.code, refused.output).not.toBe(0);
      expect(refused.output).toContain('AUTHORITY_WITNESS_REQUIRED');
      expect(await footprint()).toEqual(before);
    }
  }
  // The locks remain real. Only the witness changes between preflight and the locked recheck.
  vi.stubEnv('DECKENT_GLOBAL_HOME', dirname(globalConfig));
  for (const name of getConfigFieldDefault('cli').agentEnvironment) vi.stubEnv(name, undefined);
  vi.stubEnv('CI', undefined);
  const terminal = vi.spyOn(adapters, 'attestLocalInteractiveTerminal').mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  try {
    await expect(resumeInstallation(f.project, { allowShutdown: false, dockerExecutable, proposalDigest, acceptCustom: true }))
      .rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    expect(terminal).toHaveBeenCalledTimes(2);
    expect(await footprint()).toEqual(before);
  } finally { terminal.mockRestore(); vi.unstubAllEnvs(); }

  // Model an interruption after the approved policy bytes reached disk but before journal progress.
  const policyPath = join(f.data, 'policy.json');
  const policyBytes = Buffer.from(`${JSON.stringify(immutableJsonObjectSchema.parse(f.profile.policy))}\n`);
  await writeFile(policyPath, policyBytes, { mode: 0o600 });
  const partial = await footprint();
  expect(partial.targets).toContainEqual(policyBytes);

  // Valid marker membership matches the registry defaults, so the old fallback would pass both checks.
  const defaults = markerConfig([...getConfigFieldDefault('cli').agentEnvironment]);
  await writeFile(globalConfig, defaults, { mode: 0o600 });
  const malformed = '{';
  await writeFile(nextGlobalConfig, malformed, { mode: 0o600 });
  const corruptUnderLock = await resume();
  expect(corruptUnderLock.code, corruptUnderLock.output).toBe(78);
  expect(corruptUnderLock.output).toContain('CONFIG_READ_IO_HOLD');
  expect(await footprint()).toEqual({ ...partial, globalConfig: malformed });

  const corruptBeforeLock = await sdkRun('resume');
  expect(corruptBeforeLock.code, corruptBeforeLock.output).toBe(1);
  expect(lastJson(corruptBeforeLock.output)).toEqual({ code: 'CONFIG_READ_IO_HOLD' });
  expect(await footprint()).toEqual({ ...partial, globalConfig: malformed });
  await rm(policyPath);
  await writeFile(globalConfig, before.globalConfig, { mode: 0o600 });

  await writeFile(drift, '', { mode: 0o600 });
  const changed = await resume();
  expect(changed.code, changed.output).not.toBe(0);
  expect(changed.output).toContain('INSTALLATION_PUBLICATION_CHANGED');
  expect(await footprint()).toEqual(before);

  await rm(drift);
  const addedMarker = markerConfig([defaultMarker, customMarker, 'DECKENT_TEST_INSTALL_EXTRA_MARKER']);
  await writeFile(nextGlobalConfig, addedMarker, { mode: 0o600 });
  const markerChanged = await resume();
  expect(markerChanged.code, markerChanged.output).toBe(78);
  expect(markerChanged.output).toContain('INSTALLATION_PUBLICATION_CHANGED');
  expect(await footprint()).toEqual({ ...before, globalConfig: addedMarker });

  const reorderedMarkers = markerConfig([customMarker, defaultMarker]);
  await writeFile(globalConfig, before.globalConfig, { mode: 0o600 });
  await writeFile(nextGlobalConfig, reorderedMarkers, { mode: 0o600 });
  const installed = await resume();
  expect(await readFile(globalConfig, 'utf8')).toBe(reorderedMarkers);
  expect(installed.code, installed.output).toBe(0);
  expect(lastJson(installed.output)).toMatchObject({ status: 'installed', transactionId, proposalDigest });
  expect(JSON.parse(await readFile(journalPath, 'utf8'))).toMatchObject({ phase: 'committed', transactionId, blockers: [] });

  const committed = await footprint();
  const markedReplay = await resume({ ...env, CI: 'true' });
  expect(markedReplay.code, markedReplay.output).toBe(1);
  expect(markedReplay.output).toContain('AUTHORITY_WITNESS_REQUIRED');
  expect(await footprint()).toEqual(committed);

  await writeFile(globalConfig, '[]', { mode: 0o600 });
  const refusedReplay = await sdkRun('apply');
  expect(refusedReplay.code, refusedReplay.output).toBe(1);
  expect(lastJson(refusedReplay.output)).toEqual({ code: 'CONFIG_READ_IO_HOLD' });
  expect(await footprint()).toEqual({ ...committed, globalConfig: '[]' });
}, 90_000);
