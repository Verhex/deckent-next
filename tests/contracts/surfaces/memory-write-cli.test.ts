import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { PassThrough, Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearConfigCache } from '#platform/index.js';
import { registerProviderConfig } from '#adapters/index.js';
import type { MemoryEntry } from '#domain/index.js';
import { memoryCommand } from '#surfaces/core/cli-memory/index.js';
import type { CliCardRequest } from '#surfaces/core/cli-human/index.js';

// S4 (lead 2026-10-23): `deckent memory propose|verify|retire` is a person's terminal act. A card shows the entry; AI tools, pipes and --json are
// refused before anything is read. The card is simulated as in coding-instructions-cli (the Ink view is PTY-proven separately).
registerProviderConfig();
const card = vi.hoisted(() => ({ interactive: false, answers: [] as (string | null)[], asked: [] as CliCardRequest[] }));
vi.mock('#surfaces/core/cli-human/index.js', async importOriginal => {
  const real = await importOriginal<typeof import('#surfaces/core/cli-human/index.js')>();
  return { ...real,
    cliMode: (context: Parameters<typeof real.cliMode>[0], json?: boolean) => card.interactive && !json ? { mode: 'interactive' as const, reason: 'tty' as const } : real.cliMode(context, json),
    askCliCard: async (request: CliCardRequest, io: Parameters<typeof real.askCliCard>[1]) => {
      if (!card.interactive) return real.askCliCard(request, io);
      card.asked.push(request); return card.answers.length ? card.answers.shift()! : null;
    } };
});
beforeEach(() => { card.interactive = false; card.answers = []; card.asked = []; });
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function project() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-memory-cli-')); roots.push(root);
  const home = join(root, 'home'), dir = join(root, 'project');
  await mkdir(join(dir, '.deckent'), { recursive: true, mode: 0o700 }); await mkdir(home, { mode: 0o700 });
  await writeFile(join(dir, '.deckent', 'config.json'), JSON.stringify({ terminal: { scopeId: 'scope' } }), { mode: 0o600 });
  await writeFile(join(dir, 'lesson.json'), JSON.stringify({ kind: 'fact', title: 'Fatura kuralı', body: 'İrsaliyesiz fatura onaya düşer.', tags: [], lesson: null }));
  return { root: dir, env: { HOME: home, USERPROFILE: home, PATH: process.env['PATH'] ?? '/usr/bin:/bin' } };
}
const capture = () => { let text = ''; return { text: () => text, sink: { write: (chunk: string) => { text += chunk; return true; } } }; };
const tty = () => Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return undefined; } });
const entry: MemoryEntry = { schemaVersion: 1, scopeId: 'scope', entryId: 'lesson-fatura-1', revision: 1, state: 'candidate', contentDigest: 'a'.repeat(64),
  content: { kind: 'fact', title: 'Fatura kuralı', body: 'İrsaliyesiz fatura onaya düşer.', tags: [], lesson: null },
  provenance: { author: { issuer: 'local-os/mcp', subject: 'uid:1', ai: true }, origin: { kind: 'model', ref: null }, proposedAtMs: 1, commandId: 'lesson-fatura-1' },
  verification: null, retirement: null, updatedAtMs: 1 };
function handlers(calls: unknown[]) {
  const result = { schemaVersion: 1 as const, replayed: false, entry };
  return {
    listMemory: async () => ({ schemaVersion: 1 as const, status: 'ok' as const, scopeId: 'scope', entries: [entry] }),
    inspectMemory: async (_root: string, query: { entryId: string }) => query.entryId === entry.entryId
      ? { schemaVersion: 1 as const, status: 'ok' as const, entry, history: [entry] } : { schemaVersion: 1 as const, status: 'not-found' as const, entryId: query.entryId },
    proposeMemory: async (_root: string, input: unknown) => { calls.push(['propose', input]); return result; },
    verifyMemory: async (_root: string, input: unknown) => { calls.push(['verify', input]); return { ...result, entry: { ...entry, revision: 2, state: 'verified' as const } }; },
    retireMemory: async (_root: string, input: unknown) => { calls.push(['retire', input]); return { ...result, entry: { ...entry, revision: 2, state: 'retired' as const } }; },
  };
}

it('refuses propose, verify and retire for an AI tool, a pipe and --json before any handler runs (AUTHORITY_WITNESS_REQUIRED)', async () => {
  const f = await project(), calls: unknown[] = [];
  for (const [argv, env, stdin] of [
    [['memory', 'verify', 'lesson-f', '--note', 'ok', '--scope', 'scope'], { ...f.env, CLAUDECODE: '1' }, tty()],
    [['memory', 'retire', 'lesson-f', '--reason', 'old', '--scope', 'scope'], f.env, Object.assign(Readable.from([]), { isTTY: false })],
    [['memory', 'propose', '--input', 'lesson.json', '--scope', 'scope', '--json'], f.env, tty()],
  ] as const) {
    await expect(memoryCommand(argv, { root: f.root, env, stdin, stdout: capture().sink, ...handlers(calls) })).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
  }
  expect(calls).toEqual([]);
});

it('a person verifies on their own card: the card shows the entry and who proposed it, the writer gets its exact revision and the note', async () => {
  const f = await project(), calls: unknown[] = [], out = capture(); card.interactive = true; card.answers = ['apply'];
  await memoryCommand(['memory', 'verify', 'lesson-f', '--note', 'r1 kanıtı okundu', '--scope', 'scope', '--lang', 'en'], { root: f.root, env: f.env, stdin: tty(), stdout: out.sink, ...handlers(calls) });
  expect(card.asked).toHaveLength(1); expect(JSON.stringify(card.asked[0])).toContain('Fatura kuralı'); expect(JSON.stringify(card.asked[0])).toContain('(AI)');
  expect(calls).toMatchObject([['verify', { scopeId: 'scope', entryId: 'lesson-fatura-1', expectedRevision: 1, basis: { kind: 'human-review', note: 'r1 kanıtı okundu' } }]]);
  expect(out.text()).toContain('verified');
});

it('a cancelled card writes nothing and exits 1; retire passes reason and replacement; propose reads the content file as a human proposal', async () => {
  const f = await project(), calls: unknown[] = []; card.interactive = true;
  card.answers = [null];
  expect(await memoryCommand(['memory', 'retire', 'lesson-fatura-1', '--reason', 'old', '--scope', 'scope'], { root: f.root, env: f.env, stdin: tty(), stdout: capture().sink, stderr: capture().sink, ...handlers(calls) })).toBe(1);
  expect(calls).toEqual([]);
  card.answers = ['apply', 'apply'];
  await memoryCommand(['memory', 'retire', 'lesson-fatura-1', '--reason', 'old', '--superseded-by', 'm2', '--scope', 'scope'], { root: f.root, env: f.env, stdin: tty(), stdout: capture().sink, ...handlers(calls) });
  await memoryCommand(['memory', 'propose', '--input', 'lesson.json', '--scope', 'scope', '--lang', 'tr'], { root: f.root, env: f.env, stdin: tty(), stdout: capture().sink, ...handlers(calls) });
  expect(calls).toMatchObject([['retire', { entryId: 'lesson-fatura-1', expectedRevision: 1, reason: 'old', supersededBy: 'm2' }],
    ['propose', { scopeId: 'scope', content: { title: 'Fatura kuralı' }, origin: { kind: 'human', ref: null } }]]);
  expect(JSON.stringify(card.asked.at(-1))).toContain('İrsaliyesiz fatura onaya düşer.');
});
