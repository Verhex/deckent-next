import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const BIN = fileURLToPath(new URL('../../dist/composition/core/cli/internal/entry.js', import.meta.url));
const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };

describe.skipIf(!existsSync(BIN))('real binary', () => {
  it('deckent --version runs from dist and exits 0', async () => {
    const { stdout } = await run(process.execPath, [BIN, '--version']);
    expect(stdout.startsWith(`deckent v${version}`)).toBe(true); // build identity lines follow in a source checkout
  });
  it('unknown command exits 2', async () => {
    await expect(run(process.execPath, [BIN, 'nope'])).rejects.toMatchObject({ code: 2 });
  });
});
