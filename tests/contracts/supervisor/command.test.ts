import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { runNodeDockerCommand, DockerCommandFailure, DOCKER_CLIENT_ENV_NAMES } from '#adapters/index.js';
import { dockerCommandEnvironment, DOCKER_HOST_STRIP_NAMES } from '#adapters/core/docker-supervisor/index.js';
const command = (code: string) => ({ executable: process.execPath, args: ['-e', code], timeoutMs: 5000, outputBytes: 4096 });
it('preserves stdout/stderr and a real nonzero child exit without pretending it was interrupted', async () => {
  expect(await runNodeDockerCommand(command('process.stdout.write("out");process.stderr.write("err")'))).toMatchObject({ stdout: 'out', stderr: 'err' });
  await expect(runNodeDockerCommand(command('process.stdout.write("partial");process.exitCode=7')))
    .rejects.toMatchObject({ code: 7, killed: false, stdout: 'partial', stderr: '', message: 'SUPERVISOR_COMMAND_FAILED' });
});
it('reports deadline, abort and output overflow as interrupted control work', async () => {
  const cases = [
    () => runNodeDockerCommand({ ...command('setInterval(()=>{},1000)'), timeoutMs: 100 }),
    () => runNodeDockerCommand(command('setInterval(()=>{},1000)'), AbortSignal.abort()),
    () => runNodeDockerCommand({ ...command('process.stdout.write("x".repeat(10000))'), outputBytes: 128 }),
  ];
  for (const run of cases) await expect(run()).rejects.toMatchObject({ code: null, killed: true, message: 'SUPERVISOR_COMMAND_FAILED' });
});
it('redacts process start errors while retaining typed failure identity', async () => {
  await expect(runNodeDockerCommand({ ...command(''), executable: '/not-present/private-deckent-binary' })).rejects.toBeInstanceOf(DockerCommandFailure);
  await expect(runNodeDockerCommand({ ...command(''), executable: '/not-present/private-deckent-binary' }))
    .rejects.toMatchObject({ code: null, killed: true, stdout: '', stderr: '', message: 'SUPERVISOR_COMMAND_FAILED' });
});

it.skipIf(process.platform === 'win32')('requires POSIX self signals: reports real SIGTERM termination as interrupted control work', async () => {
  await expect(runNodeDockerCommand(command('process.kill(process.pid,"SIGTERM")')))
    .rejects.toMatchObject({ code: null, killed: true, message: 'SUPERVISOR_COMMAND_FAILED' });
});

it('A6-3: the docker client inherits only the Docker client table, never a provider key from the service environment', async () => {
  const saved = { ...process.env };
  Object.assign(process.env, { ANTHROPIC_API_KEY: 'sk-ant-fake', OPENAI_API_KEY: 'sk-fake', DOCKER_HOST: 'unix:///tmp/fake.sock', DOCKER_CONFIG: '/tmp/fake-docker' });
  try {
    const env = JSON.parse((await runNodeDockerCommand(command('process.stdout.write(JSON.stringify(process.env))'))).stdout) as Record<string, string>;
    expect(Object.keys(env).filter(name => !['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'].includes(name))).toEqual([]);
    expect(env).toMatchObject({ DOCKER_HOST: 'unix:///tmp/fake.sock', DOCKER_CONFIG: '/tmp/fake-docker', PATH: saved.PATH });
  } finally { for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name]; Object.assign(process.env, saved); }
  // KG2 E1: a packaged worker-image asset cannot import the table, so its own copy is pinned equal to it.
  for (const asset of ['build.mjs', 'recover.mjs']) {
    const source = readFileSync(`assets/worker-image/${asset}`, 'utf8'), lists = source.match(/\['PATH',[^\]]*\]/gu) ?? [], strips = source.match(/!\['DOCKER_HOST',[^\]]*\]/gu) ?? [];
    expect([lists.length, strips.length]).toEqual([1, 1]);
    expect(JSON.parse(lists[0]!.replaceAll("'", '"'))).toEqual(DOCKER_CLIENT_ENV_NAMES);
    expect(JSON.parse(strips[0]!.slice(1).replaceAll("'", '"'))).toEqual(DOCKER_HOST_STRIP_NAMES);
  }
  // A pinned local endpoint never inherits a conflicting context or TLS selector (no Docker daemon needed).
  const selectors = { DOCKER_HOST: 'tcp://other:2376', DOCKER_CONTEXT: 'remote', DOCKER_TLS: '1', DOCKER_TLS_VERIFY: '1', DOCKER_CERT_PATH: '/certs', DOCKER_CONFIG: '/cfg', PATH: '/usr/bin' };
  const pinned = { executable: 'docker', timeoutMs: 1, outputBytes: 1 };
  expect(dockerCommandEnvironment({ ...pinned, args: ['--host', 'unix:///run/docker.sock', 'info'] }, selectors)).toEqual({ DOCKER_CONFIG: '/cfg', PATH: '/usr/bin' });
  expect(dockerCommandEnvironment({ ...pinned, args: ['context', 'inspect'] }, selectors)).toEqual(selectors);
});
