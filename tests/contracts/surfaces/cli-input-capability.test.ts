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

it('ISY-33: shared JSON input errors retain the calling surface subject for every transport failure', async () => {
  const inputErrors = { subject: 'cli.input.subject.queue', unavailable: 'CLI_INVOCATION_INPUT_UNAVAILABLE', invalid: 'CLI_INVOCATION_INPUT_INVALID', limit: 'CLI_INVOCATION_INPUT_LIMIT', tty: 'CLI_INVOCATION_INPUT_TTY' };
  const malformed = await readJsonInput('-', 1024, inputErrors, Readable.from(['{'])).catch(error => error);
  expect(malformed.localize('tr').message).toBe('Kuyruk JSON verisi veya komut şeması geçersiz.');
  expect(malformed.localize('en').message).not.toContain('Model invocation');
  const memory = await readJsonInput('/missing-input-for-f2', 1024, { ...inputErrors, subject: 'cli.input.subject.memory' }).catch(error => error);
  // BeUser KER-06: a file that cannot be read names the person's own path, the cause and the next step (EN/TR); the code stays.
  expect(memory).toMatchObject({ code: 'CLI_INVOCATION_INPUT_UNAVAILABLE', params: { path: '/missing-input-for-f2', reason: 'missing' } });
  expect(memory.localize('tr').message).toBe('Hafıza girdisi okunamadı. /missing-input-for-f2 yok. Var olan bir JSON dosyasının yolunu verin ya da standart girdiden okumak için - verin.');
  expect(memory.localize('en').message).toContain('/missing-input-for-f2 does not exist. Give the path of an existing JSON file, or - to read it from standard input.');
  const limit = await readJsonInput('-', 1, { ...inputErrors, subject: 'cli.input.subject.approval' }, Readable.from(['{}'])).catch(error => error);
  expect(limit.localize('tr').message).toContain('Onay girdisi');
  const hub = await readJsonInput('-', 1024, { ...inputErrors, subject: 'cli.input.subject.hub' }, Readable.from(['{'])).catch(error => error);
  expect(hub.localize('tr').message).toBe('Hub isteği JSON verisi veya komut şeması geçersiz.');
});
