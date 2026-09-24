import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openTerminalHistoryFile } from '#adapters/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root() { const value = await mkdtemp(join(tmpdir(), 'dn-history-')); roots.push(value); return value; }

it('persists visible lines privately across sessions, redacts secret shapes and skips oversized entries', async () => {
  const path = join(await root(), 'terminal-history.jsonl');
  const first = openTerminalHistoryFile(path);
  expect(await first.load()).toEqual([]);
  await first.append({ text: 'hello' });
  await first.append({ text: 'token is sk-live-0123456789abcdef please' });
  await first.append({ text: 'x'.repeat(5000) });
  await first.append({ text: '   ' });
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  const again = await openTerminalHistoryFile(path).load();
  expect(again.map(entry => entry.text)).toEqual(['hello', expect.stringContaining('[REDACTED]')]);
  expect(await readFile(path, 'utf8')).not.toContain('sk-live-0123456789abcdef');
});

it('keeps only the newest entries and compacts the file once it doubles; refuses a symlinked history file', async () => {
  const dir = await root(); const path = join(dir, 'terminal-history.jsonl');
  const file = openTerminalHistoryFile(path, { maxEntries: 3, maxEntryBytes: 64 });
  for (let i = 0; i < 6; i++) await file.append({ text: `line ${i}` });
  expect((await file.load()).map(entry => entry.text)).toEqual(['line 3', 'line 4', 'line 5']);
  expect((await readFile(path, 'utf8')).trim().split('\n')).toHaveLength(3);
  const target = join(dir, 'elsewhere'); await writeFile(target, ''); const link = join(dir, 'linked.jsonl'); await symlink(target, link);
  expect(await openTerminalHistoryFile(link).load()).toEqual([]);
  await expect(openTerminalHistoryFile(link).append({ text: 'secret' })).rejects.toMatchObject({ code: 'ELOOP' });
  expect(await readFile(target, 'utf8')).toBe('');
});
