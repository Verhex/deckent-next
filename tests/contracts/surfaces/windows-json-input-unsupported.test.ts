import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { expect, it, vi } from 'vitest';
vi.mock('node:fs/promises', async importActual => {
  const actual = await importActual<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});
import { readGraphInput } from '../../../src/surfaces/core/cli/index.js';

// Platform guard simulation on Linux; native Windows does not offer O_NOFOLLOW.
it('Windows refuses file graph input before opening bytes and still accepts bounded stdin', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'ci-win-json-')), path = join(directory, 'graph.json');
  await fs.writeFile(path, '{"private":"must not read"}');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const open = vi.mocked(fs.open); open.mockClear();
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    await expect(readGraphInput(path, 1024)).rejects.toMatchObject({ code: 'CLI_GRAPH_INPUT_UNAVAILABLE' });
    expect(open).not.toHaveBeenCalled();
    await expect(readGraphInput('-', 1024, Readable.from(['{"safe":true}']))).resolves.toEqual({ safe: true });
  } finally { Object.defineProperty(process, 'platform', platform); await fs.rm(directory, { recursive: true, force: true }); }
});
