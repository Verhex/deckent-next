import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { processReady } from '../../fixtures/process-readiness.js';

it('waits for the application event, not spawn or unrelated IPC, and releases its listeners', async () => {
  const child = spawn(process.execPath, ['-e', `process.send('other'); process.on('message', () => {
    process.send('ready', () => process.disconnect());
  });`], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const closed = once(child, 'close');
  try {
    let ready = false;
    const waiting = processReady(child, 'ready').then(() => { ready = true; });
    await once(child, 'message');
    expect(ready).toBe(false);
    child.send('continue'); await waiting;
    expect(child.listenerCount('message')).toBe(0);
    expect(await closed).toEqual([0, null]);
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed; } }
});

it('rejects early process exit instead of waiting for a readiness timeout', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exitCode = 7'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  await expect(processReady(child, 'ready')).rejects.toThrow('PROCESS_CLOSED_BEFORE_ready:7:null');
  expect(child.listenerCount('message')).toBe(0);
});
