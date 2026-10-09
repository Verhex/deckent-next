import { mkdtemp, rm, readFile, writeFile, chmod, mkdir, readdir, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { applyPolicyTemplateInstallation, previewPolicyTemplateInstallation } from '#composition/core/installation/index.js';
import { inspectInstallationStartability } from '#composition/core/runtime-service/index.js';
import { clearConfigCache, resolveProductLayout } from '#platform/index.js';
import { prepareRuntimeSocket, runtimeSocketLocation } from '#adapters/index.js';
import { main } from '#surfaces/core/cli/index.js';

const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fresh() { const root = await mkdtemp('/tmp/dk-startability-'); roots.push(root); return root; }

it.skipIf(process.platform !== 'linux')('doctor is non-zero with typed EN/TR next steps on an uninitialized root, without creating state', async () => {
  const root = await fresh();
  for (const language of ['en', 'tr']) {
    const output: string[] = [], errors: string[] = [];
    const code = await main(['doctor', '--json', '--lang', language], { root, env: { HOME: join(root, 'home'), DECKENT_LANGUAGE: 'en' },
      stdout: { write: (line: string) => { output.push(line); } }, stderr: { write: (line: string) => { errors.push(line); } },
      inspectInstallationStartability });
    expect(code).toBe(78);
    const report = JSON.parse(output.join(''));
    expect(report).toMatchObject({ status: 'degraded', startability: { status: 'blocked' } });
    expect(report.startability.checks.map((check: { code: string }) => check.code)).toEqual(expect.arrayContaining(['DOCTOR_CONFIG_INCOMPLETE', 'DOCTOR_LEDGER_UNAVAILABLE', 'DOCTOR_POLICY_UNREADABLE']));
    expect(report.startability.checks[0].message).toContain('deckent init policy --scope <id> --apply');
    expect(report.startability.checks[0].message).toContain(language === 'tr' ? 'Eksik yapılandırma' : 'Missing configuration');
    expect(errors.join('')).toContain('INSTALLATION_NOT_STARTABLE');
    expect(await readdir(root)).toEqual([]);
  }
});

it.skipIf(process.platform !== 'linux')('checks ledger and policy readability without migrating, healing or replacing a damaged file', async () => {
  const root = await fresh(); await applyPolicyTemplateInstallation(root, 's');
  const options = { env: { HOME: join(root, 'home') } };
  const ledger = join(root, '.deckent/state/ledger.db'), policy = join(root, '.deckent/policy.json');
  await rm(ledger); await writeFile(ledger, 'corrupt', { mode: 0o600 }); await chmod(policy, 0o666);
  const report = await inspectInstallationStartability(root, options);
  expect(report.checks.map(check => check.code)).toEqual(expect.arrayContaining(['DOCTOR_LEDGER_UNAVAILABLE', 'DOCTOR_POLICY_UNREADABLE']));
  expect(await readFile(ledger, 'utf8')).toBe('corrupt');
});

it.skipIf(process.platform !== 'linux')('uses distinct short private endpoints and refuses foreign modes, symlinks and occupied non-sockets', async () => {
  const root = await fresh(), other = await fresh();
  const layout = resolveProductLayout({ projectRoot: root }), otherLayout = resolveProductLayout({ projectRoot: other });
  const endpoint = runtimeSocketLocation(layout), parent = dirname(endpoint); roots.push(parent);
  expect(runtimeSocketLocation(otherLayout)).not.toBe(endpoint);
  await mkdir(parent, { mode: 0o755 });
  await expect(prepareRuntimeSocket(layout)).rejects.toMatchObject({ code: 'LOCAL_RUNTIME_ENDPOINT_UNSAFE' });
  await chmod(parent, 0o700); await writeFile(endpoint, 'not a socket', { mode: 0o600 });
  await expect(prepareRuntimeSocket(layout)).rejects.toMatchObject({ code: 'LOCAL_RUNTIME_ENDPOINT_UNSAFE' });
  await rm(parent, { recursive: true }); await symlink(other, parent);
  await expect(prepareRuntimeSocket(layout)).rejects.toMatchObject({ code: 'LOCAL_RUNTIME_ENDPOINT_UNSAFE' });
});

it.skipIf(process.platform !== 'linux')('init keeps a pre-existing project config; preview stays read-only and conflicting policy refuses before ledger creation', async () => {
  const root = await fresh(); await mkdir(join(root, '.deckent'), { mode: 0o700 });
  const config = '{"schema_version":4,"terminal":{"scopeId":"existing"}}\n';
  await writeFile(join(root, '.deckent/config.json'), config, { mode: 0o600 });
  await previewPolicyTemplateInstallation(root, 's');
  expect(await readdir(join(root, '.deckent'))).toEqual(['config.json']);
  await writeFile(join(root, '.deckent/policy.json'), '{}', { mode: 0o600 });
  await expect(applyPolicyTemplateInstallation(root, 's')).rejects.toMatchObject({ code: 'INSTALLATION_PUBLICATION_CONFLICT' });
  expect(await readFile(join(root, '.deckent/config.json'), 'utf8')).toBe(config);
  expect(await readdir(join(root, '.deckent'))).not.toContain('state');
});
