import { expect, it } from 'vitest';
import { runNodeDockerCommand, DockerCommandFailure } from '#adapters/index.js';
const command = (code: string) => ({ executable: process.execPath, args: ['-e', code], timeoutMs: 5000, outputBytes: 4096 });
it('preserves stdout/stderr and a real nonzero child exit without pretending it was interrupted', async () => {
  expect(await runNodeDockerCommand(command('process.stdout.write("out");process.stderr.write("err")'))).toMatchObject({ stdout: 'out', stderr: 'err' });
  await expect(runNodeDockerCommand(command('process.stdout.write("partial");process.exitCode=7')))
    .rejects.toMatchObject({ code: 7, killed: false, stdout: 'partial', stderr: '', message: 'SUPERVISOR_COMMAND_FAILED' });
});
it('reports real signal termination, deadline, abort and output overflow as interrupted control work', async () => {
  const cases = [
    () => runNodeDockerCommand(command('process.kill(process.pid,"SIGTERM")')),
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
