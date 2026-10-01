import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntimeWorkspaceFileHost } from '#adapters/index.js';

import { WORKSPACE_DESCRIPTOR_CUSTODY_AVAILABLE } from '../../fixtures/workspace-descriptor-custody.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function project() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-file-host-')); roots.push(root);
  await writeFile(join(root, 'one.ts'), '1');
  return root;
}
const until = async (check: () => Promise<boolean>) => { for (let attempt = 0; attempt < 200; attempt++) { if (await check()) return; await new Promise(done => setTimeout(done, 10)); } throw new Error('TIMEOUT'); };

// TERM-UX-1 a: past its quiet time the list still answers at once; a background walk refreshes it; only a very old list is awaited.
describe.skipIf(!WORKSPACE_DESCRIPTOR_CUSTODY_AVAILABLE)('runtime workspace file host (stale while revalidate; requires Linux /proc/self/fd custody)', () => {
  it('serves the older list immediately once it is past the ttl and refreshes it in the background', async () => {
    const root = await project();
    let clock = 0;
    const host = createRuntimeWorkspaceFileHost(100, () => clock, 10_000);
    expect((await host.index(root, [])).paths).toEqual(['one.ts']);
    await writeFile(join(root, 'two.ts'), '2');
    clock = 50;
    expect((await host.index(root, [])).paths).toEqual(['one.ts']);
    clock = 150;
    // Past the ttl: the answer is the older list (no wait for a walk); the new file arrives with the background refresh.
    expect((await host.index(root, [])).paths).toEqual(['one.ts']);
    await until(async () => (await host.index(root, [])).paths.length === 2);
    expect([...(await host.index(root, [])).paths].sort()).toEqual(['one.ts', 'two.ts']);
  });

  it('walks once at a time while refreshing and awaits a fresh walk when the list is older than the stale bound', async () => {
    const root = await project();
    let clock = 0;
    const host = createRuntimeWorkspaceFileHost(100, () => clock, 1_000);
    await host.index(root, []);
    await writeFile(join(root, 'two.ts'), '2');
    clock = 5_000;
    // Older than the stale bound: the caller waits for the walk and sees the new file at once.
    expect([...(await host.index(root, [])).paths].sort()).toEqual(['one.ts', 'two.ts']);
  });

  it('keeps answering from the older list when a refresh fails', async () => {
    const root = await project();
    let clock = 0;
    const host = createRuntimeWorkspaceFileHost(100, () => clock, 10_000);
    await host.index(root, []);
    await rm(root, { recursive: true, force: true });
    clock = 500;
    expect((await host.index(root, [])).paths).toEqual(['one.ts']);
    await new Promise(done => setTimeout(done, 50));
    expect((await host.index(root, [])).paths).toEqual(['one.ts']);
  });
});
