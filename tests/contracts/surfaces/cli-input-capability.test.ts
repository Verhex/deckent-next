import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { expect, it } from 'vitest';
import { readJsonInput } from '#surfaces/core/cli-kit/index.js';

const errors = { unavailable: 'CLI_CODING_INPUT_UNAVAILABLE', invalid: 'CLI_CODING_INPUT_INVALID', limit: 'CLI_CODING_INPUT_LIMIT', tty: 'CLI_CODING_INPUT_TTY' };
it('Windows file input refuses visibly before dispatch while bounded stdin preserves the same bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-cli-file-capability-'));
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const bytes = '{"schemaVersion":1,"text":"görev"}';
  try {
    const file = join(root, 'input.json'); await writeFile(file, bytes);
    Object.defineProperty(process, 'platform', { ...original, value: 'win32' });
    await expect(readJsonInput(file, 1024, errors)).rejects.toMatchObject({ code: errors.unavailable });
    expect(await readJsonInput('-', 1024, errors, Readable.from([bytes]))).toEqual(JSON.parse(bytes));
    await expect(readJsonInput('-', 1, errors, Readable.from([bytes]))).rejects.toMatchObject({ code: errors.limit });
    expect(await readFile(file, 'utf8')).toBe(bytes); expect(await readdir(root)).toEqual(['input.json']);
  } finally { Object.defineProperty(process, 'platform', original); await rm(root, { recursive: true, force: true }); }
});
