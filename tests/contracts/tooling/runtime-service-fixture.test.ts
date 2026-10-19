import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { startConfiguredRuntimeService } from '../../../src/index.js';
import { startTestRuntimeService, stopTestRuntimeServices } from '../support/runtime-service.js';

vi.mock('../../../src/index.js', () => ({ startConfiguredRuntimeService: vi.fn() }));
const roots: string[] = [];
afterEach(async () => {
  await stopTestRuntimeServices();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  vi.resetAllMocks();
});

it('joins the runtime completion before the fixture owner can remove state, and drains it only once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-service-cleanup-')); roots.push(root);
  await mkdir(join(root, '.deckent')); await writeFile(join(root, '.deckent/config.json'), '{}');
  let stopped!: () => void, finished!: () => void;
  const stopCalled = new Promise<void>(resolve => { stopped = resolve; });
  const done = new Promise<void>(resolve => { finished = resolve; });
  const stop = vi.fn(async () => { stopped(); });
  vi.mocked(startConfiguredRuntimeService).mockResolvedValue({ stop, done } as never);
  await startTestRuntimeService(root, {});
  let drained = false;
  const draining = stopTestRuntimeServices().then(() => { drained = true; });
  try {
    await stopCalled; await Promise.resolve();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(drained).toBe(false); // stop alone does not establish that background state writes have ended.
  } finally { finished(); }
  await draining;
  expect(drained).toBe(true);
  await stopTestRuntimeServices();
  expect(stop).toHaveBeenCalledTimes(1);
});
