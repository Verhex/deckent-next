import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { runWorkerImageBuild } from '#adapters/index.js';

const roots: string[] = [];
afterAll(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });
it.skipIf(process.platform === 'win32')('an aborted signal terminates the real builder process promptly and yields no receipt', async () => {
  const context = await mkdtemp(join(tmpdir(), 'deckent-image-cancel-')); roots.push(context); await chmod(context, 0o700);
  await writeFile(join(context, 'build.mjs'), 'setInterval(() => {}, 1000);\n');
  const controller = new AbortController(); const started = Date.now();
  setTimeout(() => controller.abort(), 200);
  await expect(runWorkerImageBuild({ context, receiptPath: join(context, 'receipt.json'), timeoutMs: 60_000, outputBytes: 4096, env: { PATH: process.env.PATH ?? '/usr/bin' }, signal: controller.signal }))
    .rejects.toMatchObject({ code: 'WORKER_IMAGE_BUILD_FAILED' });
  expect(Date.now() - started).toBeLessThan(5000); // far below the 60 s bound: the process was ended, not waited for
});
it.skipIf(process.platform === 'win32')('without a signal the same builder is bounded only by its timeout', async () => {
  const context = await mkdtemp(join(tmpdir(), 'deckent-image-timeout-')); roots.push(context); await chmod(context, 0o700);
  await writeFile(join(context, 'build.mjs'), 'setInterval(() => {}, 1000);\n');
  await expect(runWorkerImageBuild({ context, receiptPath: join(context, 'receipt.json'), timeoutMs: 300, outputBytes: 4096, env: { PATH: process.env.PATH ?? '/usr/bin' } }))
    .rejects.toMatchObject({ code: 'WORKER_IMAGE_BUILD_TIMEOUT' });
});
