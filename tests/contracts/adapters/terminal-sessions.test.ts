import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openTerminalSessionStore } from '#adapters/index.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));
async function store(limits?: { maxSessions: number; maxFileBytes: number; previewChars: number }) {
  const directory = await mkdtemp(join(tmpdir(), 'dn-sessions-')); roots.push(directory);
  return { directory, sessions: openTerminalSessionStore(directory, limits) };
}
const call = { id: 'c1', name: 'read_file', argumentsJson: '{"path":"a.ts"}' };
const history = (question: string) => [{ role: 'system' as const, content: 'SYSTEM' }, { role: 'user' as const, content: question },
  { role: 'assistant' as const, content: '', toolCalls: [call] }, { role: 'tool' as const, toolCallId: 'c1', name: 'read_file', content: 'export const a = 1;' },
  { role: 'assistant' as const, content: 'It exports a.', toolCalls: [] }];

it('saves the whole history as one owner-only snapshot per session and resumes exactly the latest one, never duplicated', async () => {
  const { directory, sessions } = await store(), id = randomUUID();
  await sessions.save({ schemaVersion: 1, sessionId: id, scopeId: 'live', updatedAtMs: 1, messages: history('what does a.ts export?') });
  // A compaction rewrites the snapshot: the resumed history is exactly the latest, with no pre-compaction messages (legacy defect).
  const compacted = [{ role: 'user' as const, content: '[summary]' }, { role: 'user' as const, content: 'and b.ts?' }];
  await sessions.save({ schemaVersion: 1, sessionId: id, scopeId: 'live', updatedAtMs: 2, messages: compacted });
  expect(await sessions.load('live', id)).toEqual(compacted);
  expect(await readdir(directory)).toEqual([`${id}.json`]);
  expect((await stat(join(directory, `${id}.json`))).mode & 0o777).toBe(0o600);
  // The system prompt is never stored; another scope sees nothing; a malformed id is refused.
  await sessions.save({ schemaVersion: 1, sessionId: id, scopeId: 'live', updatedAtMs: 3, messages: history('q') });
  expect((await sessions.load('live', id))!.some(message => message.role === 'system')).toBe(false);
  expect(await sessions.load('other', id)).toBeNull(); expect(await sessions.list('other')).toEqual([]);
  expect(await sessions.load('live', '../escape')).toBeNull();
  expect(await sessions.list('live')).toEqual([{ sessionId: id, updatedAtMs: 3, messages: 4, preview: 'q' }]);
});

it('redacts known secret shapes before writing and refuses a symlinked snapshot', async () => {
  const { directory, sessions } = await store(), id = randomUUID();
  const secret = 'sk-ant-api03-' + 'A'.repeat(40);
  await sessions.save({ schemaVersion: 1, sessionId: id, scopeId: 'live', updatedAtMs: 1,
    messages: [{ role: 'user', content: `my key is ${secret}` }, { role: 'assistant', content: 'noted', toolCalls: [] }] });
  const raw = await readFile(join(directory, `${id}.json`), 'utf8');
  expect(raw).not.toContain(secret); expect(raw).toContain('[REDACTED]');
  const outside = join(directory, '..', `outside-${randomUUID()}.json`), linked = randomUUID();
  await writeFile(outside, raw.replace(id, linked)); roots.push(outside);
  await symlink(outside, join(directory, `${linked}.json`));
  expect(await sessions.load('live', linked)).toBeNull();
  expect((await sessions.list('live')).map(summary => summary.sessionId)).toEqual([id]);
});

it('redacts a large snapshot in linear time (a long letter run once made the URL-credential pattern quadratic)', async () => {
  const { sessions } = await store(), started = performance.now();
  await sessions.save({ schemaVersion: 1, sessionId: randomUUID(), scopeId: 'live', updatedAtMs: 1,
    messages: [{ role: 'user', content: 'x'.repeat(150_000) }, { role: 'assistant', content: 'see postgres://admin:s3cret@db:5432', toolCalls: [] }] });
  expect(performance.now() - started).toBeLessThan(2_000);
});

it('keeps at most the configured number of sessions, oldest removed first', async () => {
  const { directory, sessions } = await store({ maxSessions: 2, maxFileBytes: 1_000_000, previewChars: 20 });
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  for (const [index, id] of ids.entries()) await sessions.save({ schemaVersion: 1, sessionId: id, scopeId: 'live', updatedAtMs: index + 1, messages: history(`q${index}`) });
  expect((await readdir(directory)).sort()).toEqual([`${ids[1]}.json`, `${ids[2]}.json`].sort());
  expect((await sessions.list('live')).map(summary => summary.sessionId)).toEqual([ids[2], ids[1]]);
  await expect(sessions.save({ schemaVersion: 1, sessionId: randomUUID(), scopeId: 'live', updatedAtMs: 9,
    messages: [{ role: 'user', content: 'x'.repeat(2_000_000) }] })).rejects.toThrow('TERMINAL_SESSION_TOO_LARGE');
});
