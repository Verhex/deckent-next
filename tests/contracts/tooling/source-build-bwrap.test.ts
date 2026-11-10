import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, cpSync, chmodSync, openSync, closeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
// @ts-expect-error build tools are executable JavaScript, outside src's TypeScript contract.
import { preflightBubblewrap, stageBubblewrap } from '../../../scripts/stage-bubblewrap.mjs';
// @ts-expect-error build tools are executable JavaScript, outside src's TypeScript contract.
import { dockerUnavailableMessage, requireDocker, DOCKER_PREFLIGHT_INPUTS } from '../../../scripts/docker-preflight.mjs';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dk-bwrap-build-')); roots.push(root);
  mkdirSync(join(root, 'packaging/bwrap'), { recursive: true });
  writeFileSync(join(root, 'packaging/bwrap/bwrap.lock.json'), readFileSync(resolve('packaging/bwrap/bwrap.lock.json')));
  return root;
}
it('source builds stop before expensive work with localized Docker recovery and preserve the locked staging recipe', () => {
  const root = fixture(), calls: { binary: string; args: string[] }[] = [];
  const en = JSON.parse(readFileSync(resolve('packaging/bwrap/locales/en.json'), 'utf8'));
  const tr = JSON.parse(readFileSync(resolve('packaging/bwrap/locales/tr.json'), 'utf8'));
  expect(Object.keys(en).sort()).toEqual(Object.keys(tr).sort());
  for (const key of Object.keys(en)) expect(tr[key]).not.toBe(en[key]);
  const offline = () => { throw new Error('offline'); };
  const hint = (env: Record<string, string>, context?: object, socket?: string) => dockerUnavailableMessage({ env, kernel: 'Linux',
    canonical: (path: string) => socket ?? path, execute: () => { if (!context) throw new Error('offline'); return JSON.stringify([context]); } });
  const rootless = hint({ DOCKER_HOST: 'unix:///run/user/1234/docker.sock' });
  expect(rootless).toContain('systemctl --user start docker'); expect(rootless).toContain('systemctl --user enable docker');
  expect(rootless).not.toContain('sudo systemctl');
  expect(hint({ DOCKER_HOST: 'unix:///var/run/docker.sock' })).toContain('System Docker: run `sudo systemctl start docker`');
  expect(hint({}, { Name: 'rootless', Endpoints: { docker: { Host: 'unix:///run/user/1234/docker.sock' } } })).toContain('systemctl --user start docker');
  expect(hint({ DOCKER_HOST: 'unix:///var/run/docker.sock', DOCKER_CONTEXT: 'desktop-linux' },
    { Name: 'desktop-linux', Endpoints: { docker: { Host: 'unix:///desktop/docker.sock' } } })).toContain('WSL Integration');
  expect(hint({ DOCKER_HOST: 'unix:///var/run/docker.sock' }, undefined, '/mnt/wsl/docker-desktop/shared-sockets/guest-services/docker.sock')).toContain('WSL Integration');
  const unknown = hint({ DOCKER_HOST: 'ssh://user:private@remote' });
  for (const text of ['type is unknown', 'systemctl --user start docker', 'sudo systemctl start docker', 'WSL Integration']) expect(unknown).toContain(text);
  expect(unknown).not.toContain('private');
  expect(dockerUnavailableMessage({ env: { DOCKER_HOST: 'unix:///var/run/docker.sock' }, kernel: 'microsoft-standard-WSL2', execute: offline,
    canonical: (path: string) => path })).toContain('type is unknown');
  expect(hint({ DECKENT_LANGUAGE: 'tr', DOCKER_HOST: 'unix:///run/user/1234/docker.sock' })).toContain("Docker'a ulaşılamıyor");
  expect(hint({ LC_ALL: 'tr_TR.UTF-8', DECKENT_LANGUAGE: 'en' })).toContain('Docker is not reachable');
  expect(hint({ LANG: 'de_DE' })).toContain('Docker is not reachable');
  expect(() => requireDocker('BUBBLEWRAP_BUILD_REQUIRED', offline)).toThrow(/BUBBLEWRAP_BUILD_REQUIRED/u);
  let checked = false;
  preflightBubblewrap({ root, platform: 'linux', buildOutput: null, checkDocker: () => { checked = true; } });
  expect(checked).toBe(true);
  preflightBubblewrap({ root, platform: 'darwin', checkDocker: () => expect.unreachable() });
  expect(() => stageBubblewrap({ root, platform: 'linux', buildOutput: null, run(binary: string, args: string[]) {
    calls.push({ binary, args }); throw new Error('Docker unavailable');
  } })).toThrow(/BUBBLEWRAP_BUILD_REQUIRED.*locked bubblewrap.*Docker unavailable/u);
  expect(calls).toEqual([{ binary: process.execPath, args: [join(root, 'scripts/build-bwrap.mjs'), '--out', join(root, '.pack/bwrap/source-build')] }]);
  expect(existsSync(join(root, 'dist/adapters/core/shell-sandbox-bwrap/bundled'))).toBe(false);
  mkdirSync(join(root, '.pack/bwrap/source-build'), { recursive: true });
  writeFileSync(join(root, '.pack/bwrap/source-build/personal-data'), 'keep');
  expect(() => stageBubblewrap({ root, platform: 'linux', buildOutput: null, run() { expect.unreachable(); } }))
    .toThrow(/Keep it for diagnosis.*--out <fresh-directory>.*DECKENT_BWRAP_BUILD/u);
  expect(readFileSync(join(root, '.pack/bwrap/source-build/personal-data'), 'utf8')).toBe('keep');
  const verified = join(root, 'verified'), lockPath = join(root, 'packaging/bwrap/bwrap.lock.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  for (const arch of lock.shipArches) {
    mkdirSync(join(verified, 'out', arch), { recursive: true }); writeFileSync(join(verified, 'out', arch, 'bwrap'), 'verified');
    lock.outputs[arch].sha256 = createHash('sha256').update('verified').digest('hex');
  }
  writeFileSync(lockPath, JSON.stringify(lock));
  preflightBubblewrap({ root, platform: 'linux', buildOutput: verified, checkDocker: () => expect.unreachable() });
  // Real entry points in a disposable checkout: no compiler/build runs and no output gets removed or created.
  if (process.platform === 'linux') {
    const fresh = fixture(), bin = join(fresh, 'bin'); mkdirSync(bin); mkdirSync(join(fresh, 'scripts'));
    const files = ['scripts/build.mjs', 'scripts/build-worker-lineage.mjs', 'scripts/build-typescript.mjs', 'scripts/build-identity.mjs',
      'scripts/stage-bubblewrap.mjs', 'scripts/build-bwrap.mjs', 'scripts/bwrap-cache.mjs', ...DOCKER_PREFLIGHT_INPUTS];
    for (const file of files) { mkdirSync(join(fresh, file, '..'), { recursive: true }); cpSync(resolve(file), join(fresh, file)); }
    cpSync(resolve('packaging/bwrap/licenses'), join(fresh, 'packaging/bwrap/licenses'), { recursive: true });
    const docker = join(bin, 'docker'), probeLog = join(fresh, 'probes');
    writeFileSync(docker, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PROBE_LOG"\nexit 1\n'); chmodSync(docker, 0o755);
    mkdirSync(join(fresh, 'dist')); writeFileSync(join(fresh, 'dist/keep'), 'keep');
    for (const script of ['build.mjs', 'build-bwrap.mjs']) for (const language of ['en', 'tr']) {
      const errPath = join(fresh, 'error'), fd = openSync(errPath, 'w');
      const result = spawnSync(process.execPath, [join(fresh, 'scripts', script), '--out', join(fresh, 'output')], {
        env: { ...process.env, PATH: bin, PROBE_LOG: probeLog, DECKENT_LANGUAGE: language,
          DOCKER_HOST: 'unix:///run/user/1234/docker.sock', DOCKER_CONTEXT: '', DECKENT_BWRAP_BUILD: '' },
        stdio: ['ignore', 'ignore', fd], timeout: 10000,
      }); closeSync(fd);
      expect(result.status).toBe(1);
      const stderr = readFileSync(errPath, 'utf8');
      expect(stderr).toContain(script === 'build.mjs' ? 'BUBBLEWRAP_BUILD_REQUIRED' : 'BWRAP_BUILD_FAILED');
      expect(stderr).toContain(language === 'en' ? 'Docker is not reachable' : "Docker'a ulaşılamıyor");
      expect(stderr).toContain('systemctl --user start docker');
    }
    expect(readFileSync(join(fresh, 'dist/keep'), 'utf8')).toBe('keep');
    expect(existsSync(join(fresh, 'output'))).toBe(false); expect(existsSync(join(fresh, '.pack'))).toBe(false);
    expect(readFileSync(probeLog, 'utf8').trim().split('\n')).toEqual(Array(4).fill('info --format {{json .ServerVersion}}'));
  }
});
it('an invalid staged binary is refused rather than reported as a successful ABSENT build', () => {
  const root = fixture(); const bundled = join(root, 'src/adapters/core/shell-sandbox-bwrap/bundled');
  mkdirSync(join(bundled, 'linux-x64'), { recursive: true }); writeFileSync(join(bundled, 'linux-x64/bwrap'), 'wrong-digest');
  preflightBubblewrap({ root, platform: 'linux', buildOutput: null, checkDocker: () => expect.unreachable() });
  let called = false;
  expect(() => stageBubblewrap({ root, platform: 'linux', buildOutput: null, run() { called = true; } })).toThrow(/not the locked bubblewrap build/u);
  expect(called).toBe(false); expect(existsSync(join(root, 'dist/adapters/core/shell-sandbox-bwrap/bundled'))).toBe(false);
});
