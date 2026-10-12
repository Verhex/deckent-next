import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { attestLocalInteractiveTerminal } from '#adapters/index.js';
import { startInteractivePeer } from '../../fixtures/test-erp/terminal-peer.js';

it.skipIf(process.platform !== 'linux')('retains fragmented PTY readiness and attests the real peer until shutdown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-pty-fragments-'));
  const previous = process.env['PYTHONPATH'];
  // Python loads this test-only module before the fixture driver. Real PTY bytes
  // and process identity remain intact; each read deliberately returns one byte.
  await writeFile(join(root, 'sitecustomize.py'), 'import os\nread = os.read\nos.read = lambda fd, size: read(fd, min(size, 1))\n');
  process.env['PYTHONPATH'] = root;
  let terminal: Awaited<ReturnType<typeof startInteractivePeer>> | undefined;
  try {
    terminal = await startInteractivePeer();
    expect(terminal.peer.uid).toBe(userInfo().uid);
    expect(terminal.peer.pid).toBeGreaterThan(0);
    expect(terminal.peer.isConnectionActive()).toBe(true);
    expect(await attestLocalInteractiveTerminal(terminal.peer.pid, terminal.peer.uid)).toBe(true);
    await terminal.close();
    expect(terminal.peer.isConnectionActive()).toBe(false);
    expect(terminal.peer.connection.aborted).toBe(true);
    expect(await attestLocalInteractiveTerminal(terminal.peer.pid, terminal.peer.uid)).toBe(false);
  } finally {
    await terminal?.close();
    if (previous === undefined) delete process.env['PYTHONPATH']; else process.env['PYTHONPATH'] = previous;
    await rm(root, { recursive: true, force: true });
  }
});
