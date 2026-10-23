import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { PassThrough, Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearConfigCache } from '#platform/index.js';
import { registerProviderConfig } from '#adapters/index.js';
import type { MemoryContest, MemoryEntry, MemoryEvaluationRecord } from '#domain/index.js';
import type { MemoryReviewItem } from '#engine/index.js';
import { memoryCommand } from '#surfaces/core/cli-memory/index.js';
import type { CliCardRequest } from '#surfaces/core/cli-human/index.js';

// S4B-4 (S4B-DESIGN rev 4 §6.5, §6.6, A11; owner S-M10/S-M12/S-M13 2026-10-23): `deckent memory review | purge | retire --source` are a person's
// terminal cards. AI tools, pipes and --json are refused before anything is read; the purge card says honestly what is not deleted; the review card
// shows evidence and every evaluator record and counts withheld entries. Cards are simulated as in memory-write-cli (the Ink view is PTY-proven separately).
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
  const root = await mkdtemp(join(tmpdir(), 'deckent-memory-review-cli-')); roots.push(root);
  const home = join(root, 'home'), dir = join(root, 'project');
  await mkdir(join(dir, '.deckent'), { recursive: true, mode: 0o700 }); await mkdir(home, { mode: 0o700 });
  await writeFile(join(dir, '.deckent', 'config.json'), JSON.stringify({ terminal: { scopeId: 'scope' } }), { mode: 0o600 });
  return { root: dir, env: { HOME: home, USERPROFILE: home, PATH: process.env['PATH'] ?? '/usr/bin:/bin' } };
}
const capture = () => { let text = ''; return { text: () => text, sink: { write: (chunk: string) => { text += chunk; return true; } } }; };
const tty = () => Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return undefined; } });
const base = (entryId: string, title: string, state: MemoryEntry['state'] = 'candidate'): MemoryEntry => ({ schemaVersion: 2, scopeId: 'scope', entryId, revision: state === 'candidate' ? 1 : 2, state,
  contentDigest: 'a'.repeat(64), audience: { workClassFamily: 'invoice', workTargetId: null }, content: { kind: 'fact', title, body: `${title} gövdesi.`, tags: [], lesson: null },
  provenance: { author: { issuer: 'host/memory-distiller', subject: '1000', ai: true }, origin: { kind: 'run', ref: 'run/r1/task/t1/attempt/a1' }, proposedAtMs: 1, commandId: 'c' },
  verification: state === 'verified' ? { basis: 'human-review', reviewer: { issuer: 'host', subject: '1000' }, note: 'ok', verifiedAtMs: 2 } : null, retirement: null, updatedAtMs: 2 });
const candidate = base('cand-1', 'Masraf merkezi zorunlu'), contested = base('old-1', 'Eski kural', 'verified');
const shadow = { recordId: 'rec-1', mode: 'shadow', verdict: 'pass', reasonCodes: ['supported'], evaluatorModel: { channelId: 'channel-b', modelId: 'model-b', maker: 'maker-b' } } as unknown as MemoryEvaluationRecord;
const contest: MemoryContest = { schemaVersion: 1, contestId: 'con-1', scopeId: 'scope', entryId: 'old-1', candidateEntryId: 'cand-1', evaluationRecordId: 'rec-1', evaluationDigest: 'b'.repeat(64),
  openedBy: { issuer: 'host/memory-evaluator', subject: '1000' }, reasonCode: 'contradicts-verified', openedAtMs: 3 };
const item = (entry: MemoryEntry, extra: Partial<MemoryReviewItem> = {}): MemoryReviewItem => ({ entry, support: [{ schemaVersion: 1, scopeId: 'scope', entryId: entry.entryId, supportId: 's1',
  producer: 'worker-claim', source: { runId: 'r1', taskId: 't1', attemptId: 'a1' }, ruleId: 'E3', ruleVersion: 1, evaluationId: 'ev-1', evaluationDigest: 'c'.repeat(64), reportDigest: null, atMs: 2 }],
evaluations: [shadow], contests: [], stale: false, retentionMs: 30 * 86_400_000, lastSupportAtMs: 2, ...extra });
function handlers(calls: unknown[]) {
  const done = (entry: MemoryEntry) => ({ schemaVersion: 1 as const, replayed: false, entry });
  return {
    inspectMemory: async (_root: string, query: { entryId: string }) => [candidate, contested].find(entry => entry.entryId === query.entryId)
      ? { schemaVersion: 1 as const, status: 'ok' as const, entry: [candidate, contested].find(entry => entry.entryId === query.entryId)!, history: [] }
      : { schemaVersion: 1 as const, status: 'not-found' as const, entryId: query.entryId },
    reviewMemory: async (_root: string, input: unknown) => { calls.push(['review', input]); return { schemaVersion: 1 as const, status: 'ok' as const, scopeId: 'scope', complete: true, withheld: 2,
      items: [item(contested, { contests: [contest], evaluations: [] }), item(candidate, { contests: [contest] }), item({ ...base('stale-1', 'Bayat kural', 'verified') }, { stale: true, evaluations: [] })],
      contests: [contest] }; },
    listMemorySource: async (_root: string, input: unknown) => { calls.push(['source', input]); return { schemaVersion: 1 as const, status: 'ok' as const, scopeId: 'scope', complete: true, withheld: 1,
      entries: [candidate, { ...contested, state: 'retired' as const }] }; },
    verifyMemory: async (_root: string, input: unknown) => { calls.push(['verify', input]); return done({ ...candidate, state: 'verified', revision: 2 }); },
    retireMemory: async (_root: string, input: unknown) => { calls.push(['retire', input]); return done({ ...candidate, state: 'retired', revision: 2 }); },
    purgeMemory: async (_root: string, input: { entryId: string }) => { calls.push(['purge', input]); return { schemaVersion: 1 as const, replayed: false, invocations: { purged: 1, absent: 0 },
      record: {} as never, entry: { ...candidate, content: { purged: true as const, contentDigest: 'd'.repeat(64), digestKind: 'keyed' as const, purgeRecordId: 'p', reasonCode: 'personal-data' } } }; },
    resolveMemoryContest: async (_root: string, input: unknown) => { calls.push(['resolve', input]); return { schemaVersion: 1 as const, replayed: false, resolution: {} as never, retired: null }; },
  };
}

it('refuses review, purge and retire --source for an AI tool, a pipe and --json before any handler runs (AUTHORITY_WITNESS_REQUIRED)', async () => {
  const f = await project(), calls: unknown[] = [];
  for (const [argv, env, stdin] of [
    [['memory', 'review', '--scope', 'scope'], { ...f.env, CLAUDECODE: '1' }, tty()],
    [['memory', 'purge', 'cand-1', '--scope', 'scope'], f.env, Object.assign(Readable.from([]), { isTTY: false })],
    [['memory', 'purge', '--source', 'r1', '--scope', 'scope', '--json'], f.env, tty()],
    [['memory', 'retire', '--source', 'r1/a1', '--reason', 'zehirli', '--scope', 'scope'], { ...f.env, CLAUDECODE: '1' }, tty()],
  ] as const) {
    await expect(memoryCommand(argv, { root: f.root, env, stdin, stdout: capture().sink, ...handlers(calls) })).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
  }
  expect(calls).toEqual([]);
});
it('one target only: an id and --source together, neither, a replacement with --source or a malformed source are usage errors', async () => {
  const f = await project(), calls: unknown[] = []; card.interactive = true;
  for (const argv of [['memory', 'purge', 'cand-1', '--source', 'r1'], ['memory', 'purge'], ['memory', 'retire', '--source', 'r1', '--reason', 'x', '--superseded-by', 'y'],
    ['memory', 'retire', '--reason', 'x'], ['memory', 'purge', '--source', 'r1/a1/x'], ['memory', 'purge', '--source', '/a1'], ['memory', 'review', 'extra']])
    await expect(memoryCommand([...argv, '--scope', 'scope'], { root: f.root, env: f.env, stdin: tty(), stdout: capture().sink, ...handlers(calls) })).rejects.toMatchObject({ code: 'CLI_USAGE' });
  expect(calls).toEqual([]);
});
it('the purge card states what is removed and what is not; the person picks the reason; the purge gets the revision the card showed', async () => {
  const f = await project(), calls: unknown[] = [], out = capture(); card.interactive = true; card.answers = ['personal-data'];
  await memoryCommand(['memory', 'purge', 'cand-1', '--scope', 'scope', '--lang', 'en'], { root: f.root, env: f.env, stdin: tty(), stdout: out.sink, ...handlers(calls) });
  const text = JSON.stringify(card.asked[0]);
  for (const honest of ['every revision', 'evaluator calls', 'worker output', 'frozen into Runs', 'existing backups', "evaluator's provider received", 'plain digests']) expect(text).toContain(honest);
  expect(card.asked[0]!.options.map(option => option.id)).toEqual(['personal-data', 'poisoned', 'expired', 'other', 'cancel']);
  expect(calls).toMatchObject([['purge', { scopeId: 'scope', entryId: 'cand-1', expectedRevision: 1, reasonCode: 'personal-data' }]]);
  expect(out.text()).toContain('Purged cand-1');
  // Turkish card, cancelled: nothing is purged and the command exits 1.
  card.answers = ['cancel'];
  expect(await memoryCommand(['memory', 'purge', 'cand-1', '--scope', 'scope', '--lang', 'tr'], { root: f.root, env: f.env, stdin: tty(), stdout: capture().sink, stderr: capture().sink, ...handlers(calls) })).toBe(1);
  expect(JSON.stringify(card.asked[1])).toContain('mevcut yedekler'); expect(calls).toHaveLength(1);
});
it('purge and retire --source list the Run\'s entries on one card (withheld ones only counted) and apply each; retired ones are skipped', async () => {
  const f = await project(), calls: unknown[] = [], out = capture(); card.interactive = true; card.answers = ['apply', 'poisoned'];
  await memoryCommand(['memory', 'retire', '--source', 'r1/a1', '--reason', 'zehirli iş', '--scope', 'scope', '--lang', 'en'], { root: f.root, env: f.env, stdin: tty(), stdout: out.sink, ...handlers(calls) });
  await memoryCommand(['memory', 'purge', '--source', 'r1', '--scope', 'scope', '--lang', 'en'], { root: f.root, env: f.env, stdin: tty(), stdout: out.sink, ...handlers(calls) });
  expect(calls).toMatchObject([['source', { source: { runId: 'r1', attemptId: 'a1' } }], ['retire', { entryId: 'cand-1', expectedRevision: 1, reason: 'zehirli iş' }],
    ['source', { source: { runId: 'r1', attemptId: null } }], ['purge', { entryId: 'cand-1', reasonCode: 'poisoned' }], ['purge', { entryId: 'old-1', reasonCode: 'poisoned' }]]);
  expect(out.text()).toContain('1 more entries are hidden'); expect(out.text()).toContain('1 were already retired');
});
it('the review card resolves the contest first, then shows each entry with its evidence, evaluator records (shadow verifies nothing), stale and contested marks', async () => {
  const f = await project(), calls: unknown[] = [], out = capture(); card.interactive = true;
  card.answers = ['dismiss', 'skip', 'verify', 'retire'];
  await memoryCommand(['memory', 'review', '--scope', 'scope', '--lang', 'en'], { root: f.root, env: f.env, stdin: tty(), stdout: out.sink, ...handlers(calls) });
  expect(out.text()).toContain('2 more entries are hidden');
  const [contestCard, contestedCard, candidateCard, staleCard] = card.asked.map(request => JSON.stringify(request));
  expect(contestCard).toContain('Eski kural'); expect(contestCard).toContain('Masraf merkezi zorunlu');
  expect(contestedCard).toContain('Contested'); expect(contestedCard).not.toContain('"verify"');
  for (const text of ['Run r1, task t1, attempt a1', 'rule E3@1', "worker's claim", 'shadow, verifies nothing', 'channel-b/model-b of maker-b', 'family invoice']) expect(candidateCard).toContain(text);
  expect(staleCard).toContain('Stale'); expect(staleCard).toContain('30 days');
  expect(calls).toMatchObject([['review', { scopeId: 'scope' }], ['resolve', { contestId: 'con-1', decision: 'dismiss' }],
    ['verify', { entryId: 'cand-1', expectedRevision: 1, basis: { kind: 'human-review', note: 'Reviewed on the memory review card.' } }], ['retire', { entryId: 'stale-1', expectedRevision: 2 }]]);
  expect(out.text()).toContain('1 verified, 1 retired, 0 purged, 1 contests resolved, 1 skipped');
});
