import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const BIN = new URL('../../dist/surfaces/cli/entry.js', import.meta.url).pathname;

describe.skipIf(!existsSync(BIN))('real binary', () => {
  it('deckent --version runs from dist and exits 0', async () => {
    const { stdout } = await run(process.execPath, [BIN, '--version']);
    expect(stdout).toMatch(/^deckent v1\.0\.0-alpha/);
  });
  it('unknown command exits 2', async () => {
    await expect(run(process.execPath, [BIN, 'nope'])).rejects.toMatchObject({ code: 2 });
  });
});
