import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { DockerSupervisor, runNodeDockerCommand } from '#adapters/index.js';
const imageId = process.env.DECKENT_TEST_DOCKER_IMAGE;
it.skipIf(!imageId || process.platform !== 'linux')('captures actual Docker origin and restores exact immutable options without accepting foreign origin or unknown parameters', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'deckent-profile-')); const os = userInfo();
  try {
    const options = { executable: '/usr/bin/docker', imageId: imageId!, workspaceRoot, uid: os.uid, gid: os.gid,
      memoryBytes: 268435456, pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216,
      deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 };
    const original = new DockerSupervisor(options); const profile = await original.captureProfile(); const snapshot = structuredClone(options);
    options.memoryBytes *= 2;
    expect(profile.parameters.options).toEqual(snapshot); expect(Object.isFrozen(profile.parameters.options)).toBe(true);
    expect(profile.adapterVersion).toBe(2);
    expect(profile.parameters.endpoint).toMatch(/^unix:\/\/\//);
    const originalHost = process.env.DOCKER_HOST; const originalContext = process.env.DOCKER_CONTEXT;
    let restored: DockerSupervisor;
    try {
      process.env.DOCKER_HOST = 'unix:///tmp/deckent-profile-missing.sock';
      process.env.DOCKER_CONTEXT = 'deckent-profile-missing-context';
      restored = await DockerSupervisor.restoreProfile(JSON.parse(JSON.stringify(profile)), async (command, signal) => {
        expect(command.args.slice(0, 2)).toEqual(['--host', profile.parameters.endpoint]);
        return runNodeDockerCommand(command, signal);
      });
      expect(await restored.captureProfile()).toEqual(profile);
    } finally {
      if (originalHost === undefined) delete process.env.DOCKER_HOST; else process.env.DOCKER_HOST = originalHost;
      if (originalContext === undefined) delete process.env.DOCKER_CONTEXT; else process.env.DOCKER_CONTEXT = originalContext;
    }
    expect(await restored.captureProfile()).toEqual(profile);
    const changed = JSON.parse(JSON.stringify(profile)); changed.parameters.origin.daemonId = 'foreign-daemon';
    await expect(DockerSupervisor.restoreProfile(changed)).rejects.toMatchObject({ code: 'SUPERVISOR_PROFILE_ORIGIN_MISMATCH' });
    changed.parameters.origin.hostname = 'foreign-host';
    let commands = 0;
    await expect(DockerSupervisor.restoreProfile(changed, async () => { commands++; throw new Error('must not contact daemon'); })).rejects.toMatchObject({ code: 'SUPERVISOR_PROFILE_ORIGIN_MISMATCH' });
    expect(commands).toBe(0);
    const invalid = JSON.parse(JSON.stringify(profile)); invalid.parameters.options.secret = 'not-accepted';
    await expect(DockerSupervisor.restoreProfile(invalid)).rejects.toMatchObject({ code: 'SUPERVISOR_PROFILE_INVALID' });
    await expect(DockerSupervisor.restoreProfile({ ...profile, adapterVersion: 1 })).rejects.toMatchObject({ code: 'SUPERVISOR_PROFILE_INVALID' });
  } finally { await rm(workspaceRoot, { recursive: true, force: true }); }
}, 15000);
