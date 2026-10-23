import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { PassThrough, Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearConfigCache } from '#platform/index.js';
import { registerProviderConfig } from '#adapters/index.js';
import type { WorkerInstructionStatus } from '#engine/index.js';
import { main } from '#surfaces/core/cli/index.js';
import type { CliCardRequest } from '#surfaces/core/cli-human/index.js';

registerProviderConfig();
/** A person's card is simulated as in cli-admin-human (the Ink view is PTY-proven separately); refusals use the real mode decision. */
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

/** alpha.53 F1: `deckent coding instructions status|trust|revoke` — trust only from a person's own terminal card; status is read-only. */
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function project() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-instructions-cli-')); roots.push(root);
  const home = join(root, 'home'), dir = join(root, 'project');
  await mkdir(join(dir, '.deckent'), { recursive: true, mode: 0o700 }); await mkdir(home, { mode: 0o700 });
  await writeFile(join(dir, '.deckent', 'config.json'), JSON.stringify({ terminal: { scopeId: 'scope' } }), { mode: 0o600 });
  return { root: dir, env: { HOME: home, USERPROFILE: home, PATH: process.env['PATH'] ?? '/usr/bin:/bin', DECKENT_LANGUAGE: 'en' } };
}
const capture = () => { const lines: string[] = []; return { lines, text: () => lines.join(''), sink: { write: (text: string) => { lines.push(String(text)); return true; } } }; };
const piped = () => Object.assign(Readable.from([]), { isTTY: false });
const tty = () => Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return undefined; } });
const DIGEST = 'ab'.repeat(32);
const row = (state: WorkerInstructionStatus['state']): WorkerInstructionStatus => ({ target: 'n1', root: '/work/n1', ref: null, source: 'worker-md', file: '.deckent/worker-instructions.md',
  explicit: false, off: null, state, reason: null, path: '/work/n1/.deckent/worker-instructions.md', bytes: 31, digest: DIGEST, preview: ['Run npm test before reporting.'], binding: BINDING, commit: null });
/** The host-made canonical place of the card (REVISE 2734 R1): the CLI hands exactly this to the writer, never a digest or target id alone. */
const BINDING = { target: 'n1', root: '/real/n1', rootDev: 1, rootIno: 2, source: 'worker-md', file: '.deckent/worker-instructions.md', ref: null,
  path: '/real/n1/.deckent/worker-instructions.md', commit: null, blobOid: null, fileDev: 1, fileIno: 3, digest: DIGEST };
const COMMIT = 'c0'.repeat(20), REF = 'refs/heads/main';
/** alpha.54 R1: a work target's file is read at its base ref; the row names the ref and the commit it named. */
const atRef = (state: WorkerInstructionStatus['state']): WorkerInstructionStatus => state === 'absent'
  ? { ...row(state), ref: REF, path: null, bytes: null, digest: null, preview: [], binding: null }
  : { ...row(state), ref: REF, commit: COMMIT, path: `${REF}:.deckent/worker-instructions.md`, binding: { ...BINDING, ref: REF, path: `${REF}:.deckent/worker-instructions.md`, commit: COMMIT,
    blobOid: 'b1'.repeat(20), fileDev: null, fileIno: null } };
function handlers(state: WorkerInstructionStatus['state'], calls: unknown[], shape: typeof row = row) {
  return {
    inspectWorkerInstructions: async () => ({ schemaVersion: 1 as const, targets: [shape(state)] }),
    changeWorkerInstructionTrust: async (_root: string, input: { scopeId: string; action: 'trust' | 'revoke'; binding: typeof BINDING }) => {
      calls.push(input);
      return { schemaVersion: 1 as const, action: input.action, target: 'n1', path: row(state).path!, digest: DIGEST, trusted: input.action === 'trust', changed: true, decisionEventId: 'decision:x' };
    },
  };
}

it('refuses trust and revoke for an AI tool, a pipe and --json before any handler runs (typed AUTHORITY_WITNESS_REQUIRED)', async () => {
  const f = await project(), calls: unknown[] = [];
  const screen = () => Object.assign(capture().sink, { isTTY: true });
  for (const [argv, env, stdin] of [
    [['coding', 'instructions', 'trust', '--scope', 'scope'], { ...f.env, CLAUDECODE: '1' }, tty()],
    [['coding', 'instructions', 'revoke', '--scope', 'scope'], f.env, piped()],
    [['coding', 'instructions', 'trust', '--scope', 'scope', '--json'], f.env, tty()],
  ] as const) {
    const err = capture();
    expect(await main([...argv], { root: f.root, env, stdin, stdout: screen(), stderr: err.sink, ...handlers('untrusted', calls) }), argv.join(' ')).not.toBe(0);
    expect(err.text(), argv.join(' ')).toContain('AUTHORITY_WITNESS_REQUIRED');
  }
  expect(calls).toEqual([]);
});

it('status is read-only, human in both languages and typed with --json; a bare `coding instructions` is status', async () => {
  const f = await project(), calls: unknown[] = [];
  const en = capture();
  expect(await main(['coding', 'instructions'], { root: f.root, env: f.env, stdin: piped(), stdout: en.sink, stderr: capture().sink, ...handlers('untrusted', calls) })).toBe(0);
  expect(en.text()).toContain('Work target n1 · /work/n1');
  expect(en.text()).toContain(`SHA-256 ${DIGEST}`);
  expect(en.text()).toContain('Not trusted for this content');
  expect(en.text()).toContain('deckent coding instructions trust --scope <id>');
  const tr = capture();
  expect(await main(['coding', 'instructions', 'status', '--lang', 'tr'], { root: f.root, env: f.env, stdin: piped(), stdout: tr.sink, stderr: capture().sink, ...handlers('trusted', calls) })).toBe(0);
  expect(tr.text()).toContain('Güvenilir: buradaki worker');
  const json = capture();
  expect(await main(['coding', 'instructions', 'status', '--json'], { root: f.root, env: f.env, stdin: piped(), stdout: json.sink, stderr: capture().sink, ...handlers('trusted', calls) })).toBe(0);
  expect(JSON.parse(json.text())).toMatchObject({ schemaVersion: 1, targets: [{ target: 'n1', state: 'trusted', digest: DIGEST }] });
  // status takes no scope or target (it changes nothing); an unknown action is a usage error
  for (const argv of [['coding', 'instructions', 'status', '--scope', 'scope'], ['coding', 'instructions', 'grant']]) {
    const err = capture();
    expect(await main(argv, { root: f.root, env: f.env, stdin: piped(), stdout: capture().sink, stderr: err.sink, ...handlers('trusted', calls) }), argv.join(' ')).toBe(2);
  }
  expect(calls).toEqual([]);
});

it('a person confirms the card: trust passes the exact place shown (host-made binding); cancel, no-op and a wrong target change nothing', async () => {
  const f = await project(), calls: unknown[] = [];
  card.interactive = true; card.answers = ['apply'];
  const out = capture(), err = capture();
  expect(await main(['coding', 'instructions', 'trust', '--scope', 'scope'], { root: f.root, env: f.env, stdin: piped(), stdout: out.sink, stderr: err.sink,
    ...handlers('untrusted', calls) }), err.text()).toBe(0);
  expect(card.asked[0]).toMatchObject({ title: 'Trust this worker instruction file?' });
  expect(card.asked[0]!.body).toEqual(['Work target n1 · /work/n1', `File /work/n1/.deckent/worker-instructions.md · 31 bytes · SHA-256 ${DIGEST}`,
    expect.stringContaining('It grants no permission'), '', '  Run npm test before reporting.']);
  expect(card.asked[0]!.options.map(option => option.id)).toEqual(['apply', 'cancel']); expect(card.asked[0]!.initial).toBeUndefined();
  expect(out.text()).toContain(`Trusted (SHA-256 ${DIGEST})`);
  expect(calls).toEqual([{ scopeId: 'scope', action: 'trust', binding: BINDING }]);
  card.answers = ['cancel'];
  const cancelled = capture();
  expect(await main(['coding', 'instructions', 'revoke', '--scope', 'scope'], { root: f.root, env: f.env, stdin: piped(), stdout: capture().sink, stderr: cancelled.sink,
    ...handlers('trusted', calls) })).toBe(1);
  expect(cancelled.text()).toContain('nothing was changed');
  card.answers = ['apply'];
  const revoked = capture();
  expect(await main(['coding', 'instructions', 'revoke', '--scope', 'scope', '--lang', 'tr'], { root: f.root, env: f.env, stdin: piped(), stdout: revoked.sink, stderr: capture().sink,
    ...handlers('trusted', calls) })).toBe(0);
  expect(revoked.text()).toContain(`Güven geri alındı (SHA-256 ${DIGEST})`);
  const already = capture(), asked = card.asked.length;
  expect(await main(['coding', 'instructions', 'trust', '--scope', 'scope'], { root: f.root, env: f.env, stdin: piped(), stdout: already.sink, stderr: capture().sink,
    ...handlers('trusted', calls) })).toBe(0);
  expect(already.text()).toContain('Already trusted for this content'); expect(card.asked).toHaveLength(asked);
  const wrongTarget = capture();
  expect(await main(['coding', 'instructions', 'trust', '--scope', 'scope', '--target', 'other'], { root: f.root, env: f.env, stdin: piped(), stdout: capture().sink,
    stderr: wrongTarget.sink, ...handlers('untrusted', calls) })).not.toBe(0);
  expect(wrongTarget.text()).toContain('WORKER_INSTRUCTIONS_UNAVAILABLE');
  expect(calls).toEqual([{ scopeId: 'scope', action: 'trust', binding: BINDING }, { scopeId: 'scope', action: 'revoke', binding: BINDING }]);
});

it('alpha.54 R1: a work target row names the ref and commit it was read from in status and on the card, in both languages', async () => {
  const f = await project(), calls: unknown[] = [];
  const en = capture();
  expect(await main(['coding', 'instructions'], { root: f.root, env: f.env, stdin: piped(), stdout: en.sink, stderr: capture().sink, ...handlers('untrusted', calls, atRef) })).toBe(0);
  expect(en.text()).toContain(`File ${REF}:.deckent/worker-instructions.md · 31 bytes`);
  expect(en.text()).toContain(`Committed on ${REF} at ${COMMIT}; uncommitted changes in this folder are not used.`);
  const tr = capture();
  expect(await main(['coding', 'instructions', '--lang', 'tr'], { root: f.root, env: f.env, stdin: piped(), stdout: tr.sink, stderr: capture().sink, ...handlers('trusted', calls, atRef) })).toBe(0);
  expect(tr.text()).toContain(`${REF} üzerinde ${COMMIT} commit'indeki sürüm; bu klasörde commit edilmemiş değişiklikler kullanılmaz.`);
  for (const [lang, text] of [['en', `No .deckent/worker-instructions.md committed on ${REF}`], ['tr', `${REF} üzerinde commit edilmiş .deckent/worker-instructions.md yok`]] as const) {
    const out = capture();
    expect(await main(['coding', 'instructions', '--lang', lang], { root: f.root, env: f.env, stdin: piped(), stdout: out.sink, stderr: capture().sink, ...handlers('absent', calls, atRef) })).toBe(0);
    expect(out.text()).toContain(text);
  }
  card.interactive = true; card.answers = ['apply'];
  expect(await main(['coding', 'instructions', 'trust', '--scope', 'scope'], { root: f.root, env: f.env, stdin: piped(), stdout: capture().sink, stderr: capture().sink,
    ...handlers('untrusted', calls, atRef) })).toBe(0);
  expect(card.asked[0]!.body.slice(0, 3)).toEqual(['Work target n1 · /work/n1', `File ${REF}:.deckent/worker-instructions.md · 31 bytes · SHA-256 ${DIGEST}`,
    `Committed on ${REF} at ${COMMIT}; uncommitted changes in this folder are not used.`]);
  expect(calls).toEqual([{ scopeId: 'scope', action: 'trust', binding: atRef('untrusted').binding }]);
});
