import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nativeAgentRealmAvailable, writeFakeAgentCli, type FakeAgentScenario } from '../fixtures/native-headless/agent.js';
import { personEnv } from '../contracts/support/person-env.js';
import { openPtySession, type PtySession } from '../contracts/support/pty-session.js';

// The owner's FINAL-CHECK-2 walk (2026-11-08) as one hermetic journey on the built binary: a disposable install (its own HOME, global home and
// projects under a private folder), fake subscription CLIs on PATH (no provider, no network, no real login), the real runtime service the terminal
// starts, and this test as the install's person typing on a real controlling PTY. Acting as the person is allowed only here (deckent-beuser safety).
const cli = resolve('dist/composition/core/cli/internal/entry.js');
const OUT = process.env['JOURNEY_OUT'];
const CTRL_O = '\u000f', ESC = '\u001b', DOWN = '\u001b[B';
const sessions: PtySession[] = [];
type Step = readonly [wait: string | RegExp | number, keys: string];
// Bounded time: one wait gives up after JOURNEY_WAIT_MS and the whole journey after JOURNEY_BUDGET_MS, so a red step fails fast, never a hung job.
const WAIT_MS = Number(process.env['JOURNEY_WAIT_MS'] ?? 60_000), deadline = Date.now() + Number(process.env['JOURNEY_BUDGET_MS'] ?? 900_000);
const within = (ms = WAIT_MS) => Math.max(1_000, Math.min(ms, deadline - Date.now()));
const pause = (ms: number) => new Promise(resolveWait => setTimeout(resolveWait, ms));
const dump = async (name: string, s: PtySession) => { if (OUT) await writeFile(join(OUT, `${name}.txt`), s.text()); };
/** Each wait looks only at output after the previous step's keys (an earlier frame never answers a later card); a number is a plain pause. */
async function walk(name: string, s: PtySession, steps: readonly Step[]) {
  let from = s.mark();
  try { for (const [wait, keys] of steps) { if (typeof wait === 'number') await pause(wait); else await s.waitFor(wait, from, within()); from = s.mark(); await s.type(keys); } }
  finally { await dump(name, s); }
}
/** A first open's setup cards as the person: the profile and rights are confirmed, every other step is left for later. Returns the subscription
 * choices the worker-kind card offered (F2-13: one row per subscription, each naming it, so no two rows read the same). */
async function firstOpen(t: PtySession) {
  const rows: string[] = [];
  for (let step = 0; step < 10; step++) {
    const mark = t.mark();
    if (!await t.waitFor(/Step \d+\/\d+/u, mark, within(15_000)).then(() => true, () => false)) break;
    await pause(1500);
    const shown = t.flat(mark);
    if (/Use my \w+ subscription/u.test(shown)) rows.push(...[...shown.matchAll(/(?:>|›)?\s*(Use my [^>›]*?subscription[^>›]*?)(?=\s+(?:Use my|Change|Enter)|$)/gu)].map(row => row[1]!.trim()));
    await t.type(/Give me these rights|rights are given|Continue opens this profile|Confirm to complete/u.test(shown.slice(-1500)) ? '\r' : ESC);
  }
  return rows;
}
/** Processes of this disposable install (its global home in their environment): the runtime services and any worker they left. */
const installProcesses = (global: string) => readdirSync('/proc').filter(pid => /^\d+$/u.test(pid) && Number(pid) !== process.pid).filter(pid => {
  try { return readFileSync(`/proc/${pid}/environ`, 'latin1').split('\0').includes(`DECKENT_GLOBAL_HOME=${global}`); } catch { return false; }
}).map(Number);
/** Whether a fake worker of this install runs now: an agent call (the MCP bridge config) whose command line names this install's folders. */
const workerRunning = (root: string) => readdirSync('/proc').some(pid => {
  try { const line = readFileSync(`/proc/${pid}/cmdline`, 'utf8'); return line.includes('--mcp-config') && line.includes(root); } catch { return false; }
});
/** A card answered after it is drawn: its keys count only once it listens (decision arming). */
const card = (title: string | RegExp, keys = '\r'): Step[] => [[title, ''], [1200, keys]];

async function fakeCli(bin: string, family: string, name: string, scenario: FakeAgentScenario) {
  const dir = await mkdtemp(join(dirname(bin), `${name}-`));
  await rename(await writeFakeAgentCli(dir, family, scenario), join(bin, name));
  await rm(dir, { recursive: true });
}
/** The fake Brain: a valid run proposal for the supplied kind, a `small` one-line edit (what a correct planner returns for this intent). */
const BRAIN = `const d = JSON.parse(prompt), kind = d.context.context.kinds[0].kind;
  return JSON.stringify({ graph: { schemaVersion: 4, revision: 1, tasks: [{ id: 'edit', kind, workClass: 'small', dependencies: [], acceptanceCriteria: ['exit'],
    workInput: { schemaVersion: 2, title: 'Append a line to notes.txt', task: d.intent, scope: { paths: ['notes.txt'] }, acceptance: 'notes.txt ends with the requested line.', workClass: 'small' } }],
    criterionDefinitions: [{ id: 'exit', version: 1, description: 'The worker finished', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] },
    budgetCeiling: { currency: 'USD', limitMinorUnits: 0 }, requiredPermissions: [] });`;
// Prerequisites: the built binary, python3 with `pty` (the PTY relay), Linux with the isolation realm (bubblewrap). The hosted CI shard job has a
// 6-minute bound and this journey takes longer, so a hosted run skips unless JOURNEY_HOSTED=1 (a dedicated job). Each skip is a recorded reason.
const FILE = 'tests/e2e/owner-journey.test.ts';
const missing = process.env['GITHUB_ACTIONS'] === 'true' && process.env['JOURNEY_HOSTED'] !== '1' ? 'hosted-shard-budget'
  : !existsSync(cli) ? 'built-binary-missing' : spawnSync('python3', ['-c', 'import pty'], { timeout: 10_000 }).status !== 0 ? 'python3-pty-missing' : null;
if (missing) console.info('verify-not-run: ' + JSON.stringify({ file: FILE, test: 'owner journey', variant: 'owner-journey', platform: process.platform, reason: missing }));
const git = (cwd: string, ...args: string[]) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8' }).trim();
/** A person's new project: a Git repository with one committed notes.txt. */
async function gitProject(root: string, name: string) {
  const dir = join(root, name); await mkdir(dir, { mode: 0o700 });
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 'person@example.invalid'); git(dir, 'config', 'user.name', 'Person');
  await writeFile(join(dir, 'notes.txt'), 'first line\n'); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'init');
  return dir;
}
/** The worker's scripted tool call (writes notes.txt) and its final report. */
const notes = (...lines: string[]) => ({ name: 'write_file', arguments: { path: 'notes.txt', content: lines.map(line => `${line}\n`).join('') } });
const report = JSON.stringify({ schemaVersion: 1, summary: 'appended the line', changedFiles: ['notes.txt'], checks: [], openIssues: [] });
/** One scripted turn per marker: the Brain call (no tools) answers a plan for its intent, the worker call (tools) writes the file and reports
 * (JOURNEY-C's worker waits 10 s before its tool call, so the person edits the file while it runs). */
function journeyTurns() {
  return [
    { when: 'JOURNEY-A', textFrom: BRAIN, calls: [notes('first line', 'person line', 'second line')], answer: report },
    { when: 'JOURNEY-C', textFrom: BRAIN, delayMs: 10_000, calls: [notes('first line', 'person line', 'third line')], answer: report },
    { when: 'JOURNEY-D', textFrom: BRAIN, calls: [notes('first line', 'person line', 'agent line')], answer: report },
    { when: 'JOURNEY-HELLO', calls: [{ name: 'write_file', arguments: { path: 'hello.txt', content: 'hello\n' } }], answer: 'wrote hello.txt' },
    // J5 chat turns answer with their own words (a repainted earlier answer never satisfies a later wait), ending in '.': a trailing character
    // that starts a known secret (the random bridge token) is shown masked, so a wait never ends on a letter.
    ...['G-CODEX', 'G-CLAUDE', 'H-CLAUDE', 'H-CODEX'].map(turn => ({ when: `JOURNEY-${turn}`, answer: `answered ${turn.toLowerCase()}.` })),
  ];
}
const denied = /PROJECT_ATTACHMENT_DENIED|installation owner|only with your approval|Unexpected operation failure/u;
const realm = !missing && await nativeAgentRealmAvailable(FILE, 'owner journey');
// The dedicated CI journey job (JOURNEY_HOSTED=1) is the gate: a missing prerequisite fails there, never a quiet skip (Astra 3048 R1).
if (process.env['JOURNEY_HOSTED'] === '1' && !realm) throw new Error(`OWNER_JOURNEY_PREREQUISITE_MISSING: ${missing ?? 'isolation-realm-unavailable'}`);

describe.skipIf(!realm)('owner journey FINAL-CHECK-2 (synthetic-person in a disposable install)', { timeout: 300_000 }, () => {
  let root = '', project = '', global = '', bin = '', env: NodeJS.ProcessEnv = {}; const folders: string[] = []; // every project folder, stopped at the end
  const open = (args: string[] = [], cwd = project) => { const s = openPtySession([process.execPath, cli, ...args], cwd, env); sessions.push(s); return s; };

  beforeAll(async () => {
    // A private parent: the product refuses a personal sign-in store under a world-writable /tmp. This checkout's ignored .pack folder.
    const parent = resolve(process.env['DECKENT_JOURNEY_ROOT'] ?? '.pack/journey'); await mkdir(parent, { recursive: true, mode: 0o700 });
    root = await mkdtemp(join(parent, 'j-'));
    const home = join(root, 'home'); bin = join(root, 'bin'); global = join(root, 'global');
    for (const dir of [home, global, bin]) await mkdir(dir, { recursive: true, mode: 0o700 });
    project = await gitProject(root, 'C'); folders.push(project);
    env = personEnv({ PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, DECKENT_GLOBAL_HOME: global, TERM: 'xterm-256color', NO_COLOR: '1',
      DECKENT_LANGUAGE: 'en', LANG: 'C.UTF-8' });
    // The fakes are CommonJS scripts; this checkout's package.json says "module", so their folder says otherwise.
    await writeFile(join(bin, 'package.json'), '{"type":"commonjs"}');
    const turns = journeyTurns();
    await fakeCli(bin, 'claude-code-stream-json', 'claude', { turns });
    await fakeCli(bin, 'codex-jsonl', 'codex', { turns });
    const init = open(['init', '--here', '--yes', '--scope', 'c']);
    await init.closed; await dump('init', init);
    // First open: onboarding with the Claude subscription sign-in (the fake CLI's own `auth login`), as the owner's C was set up.
    const t = open();
    await walk('onboarding', t, [['Choose a profile to preview', CTRL_O], [800, '\r'], ...card('Confirm to complete'), ...card('Give me these rights'), ...card('rights are given'),
      ...card('No model is connected yet'), ...card('Sign in with Claude · no extra charge ›'), ...card('Sign in with its CLI and connect'), ...card("Deckent's own login directory"),
      ...card('who besides you may use this login'), ...card('Model connected'), ...card('Use my claude subscription'), ...card('Project instructions', ESC), [3000, '/exit\r']]);
    await t.closed;
    // Owner 2026-11-08: the consent card says the chat's AI may use the login by default. NF-2 + R8b: the one subscription choice writes the first kind.
    expect(t.flat()).toContain('You and the AI in this chat may use this sign-in'); expect(t.flat()).not.toContain('Declare work kind');
    expect(JSON.parse(await readFile(join(project, '.deckent', 'config.json'), 'utf8')).admission?.registry?.kinds?.map((row: { kind: string }) => row.kind), t.text().slice(-3000)).toEqual(['coding']);
  }, 300_000);
  afterAll(async () => {
    for (const s of sessions.splice(0)) await s.close();
    // Every project's background service is stopped and whatever still runs with this install's global home is ended, also after a red step.
    for (const folder of folders) try { execFileSync(process.execPath, [cli, 'runtime', 'shutdown', '--force', '--reason', 'journey test end'], { cwd: folder, env, timeout: 30_000, stdio: 'ignore' }); } catch { /* not running */ }
    if (global) for (const pid of installProcesses(global)) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    if (root && !process.env['JOURNEY_KEEP']) await rm(root, { recursive: true, force: true });
  }, 120_000);

  it('J1 + J3 chat on the connected Claude subscription: /model (F2-1), first turn verifies tools, /provider, a careful-mode edit card and Esc', async () => {
    const t = open();
    // Rows are chosen by typing to filter: /model orders by tier (F2-14), so a row's position is not the journey's to know.
    await walk('j1-set', t, [[/Ready/, '/model'], [1500, '\r'], ['Claude Sonnet 5.5 (Sign in', ''], [800, 'sonnet'], [1000, '\r'], ['Use as Brain model (this project)', ''],
      [800, '\r'], ['make it my default', ''], [800, '\r'], [3000, '/model'], [1500, '\r'], ['Claude Opus 5.5 (Sign in', ''], [800, 'opus'], [1000, '\r'],
      ['Use as Brain model (this project)', ''], [800, DOWN.repeat(2)], [600, '\r'], ['now plans /do work', ''], [1500, '/exit\r']]);
    await t.closed;
    // "This session, and make it my default" is offered first; "Use as Brain model (your default)" reaches the host port and closes (F2-1).
    const scope = t.flat(); expect(scope.indexOf('This session, and make it my default')).toBeLessThan(scope.indexOf('This session only'));
    expect(JSON.parse(await readFile(join(global, 'config.json'), 'utf8')).brain_planner?.reference).toMatchObject({ providerId: 'claude-cli-subscription', modelId: 'opus-5-5' });
    // Owner checklist 1-3: no "cannot use tools" band, /model shows the chat model and the Brain mark without a USD budget row, the first turn
    // verifies the tools and /provider then says verified.
    const s = open(), from = s.mark();
    await walk('j1', s, [[/Ready/, '/model'], [1500, '\r'], ['Models · c', ''], [2000, DOWN.repeat(2)], [2500, ESC], [1500, 'hello'], [600, '\r'], ['agent comp', ''], [1500, '/provider'], [1500, '\r'],
      ['Sign in with Claude ›', ''], [2500, ESC], [1500, '/exit\r']]);
    await s.closed;
    const seen = s.flat(from);
    expect(seen).not.toContain('This model cannot use tools here');
    expect(seen).toContain('Claude Sonnet 5.5 (Sign in with Claude) · default'); expect.soft(seen, 'Brain mark on /model').toContain('plans /do work (Brain model)');
    expect(seen).not.toMatch(/USD|\$\s?\d/u);
    expect(seen).toContain('claude-sonnet-5-5: Agent prerequisites verified');
    // J3
    const m = open(), mFrom = m.mark();
    // NF-7: a reopened terminal's /provider still says the tools were verified (the first turn's verification is kept, not re-asked).
    await walk('j3-provider', m, [[/Ready/, '/provider'], [1500, '\r'], ['Sign in with Claude ›', ''], [2500, ESC]]);
    expect.soft(m.flat(mFrom), 'NF-7 /provider after reopening').toContain('claude-sonnet-5-5: Agent prerequisites verified');
    // The mode window (typed /mode arguments are not used in the terminal): careful, then back to full auto for the /do journeys.
    await walk('j3', m, [[1500, '/mode'], [1500, '\r'], ['careful', ''], [1500, DOWN], [800, '\r'], [3000, 'JOURNEY-HELLO write hello into hello.txt'], [600, '\r'],
      ['the AI in this chat, on your behalf', ''], [2500, ESC], [4000, '/mode'], [1500, '\r'], ['careful', ''], [1500, DOWN.repeat(2)], [800, '\r'], [2000, '/exit\r']]);
    await m.closed;
    expect.soft(m.flat(mFrom)).not.toMatch(/peer-session|Policy cell/u); // F2-10 jargon
    await expect(readFile(join(project, 'hello.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('J2 + J4 /do appends a line (plan card, files without a commit, /tasks, rollback, conflict); a small agent with a skill is bound (F2-11)', async () => {
    // Owner step 4: the person adds a line by hand before /do (working-tree delivery starts from it).
    await writeFile(join(project, 'notes.txt'), 'first line\nperson line\n');
    const t = open(), from = t.mark();
    await walk('j2', t, [[/Ready/, '/do JOURNEY-A append the line "second line" to notes.txt'], [800, '\r'], ...card('This folder has uncommitted changes'),
      ['Approval needed', ''], [2500, 'y'], ['admitted. Follow', ''], [1500, CTRL_O], [800, ESC], ['awaiting delivery', ''], [2000, '/deliver'], [1500, '\r'],
      ['y check, prepare and deliver', ''], [2500, 'y'], ['Written into your files (no commit)', ''], [1500, '\r'], [1500, '/tasks'], [1500, '\r'], ['Background work', ''],
      [2500, CTRL_O], [800, DOWN], [800, 'x'], [/already finished|nothing to cancel/u, ''], [1500, ESC], [1500, '/exit\r']]);
    await t.closed;
    const seen = t.flat(from), plan = seen.slice(seen.indexOf('Approval needed'), seen.indexOf('admitted. Follow'));
    // The plan card: no money ceiling line for a subscription and no internal codes (F2-12); no worker card after y; one written-to-files delivery.
    expect(plan).not.toMatch(/\$\s?\d|APPROVAL_REQUIRED|[0-9a-f]{64}/u);
    expect(seen.slice(seen.indexOf('admitted. Follow'))).not.toContain('Approval needed');
    expect(seen).toContain('the change is written into your files (no commit');
    // NF-4: the uncommitted-changes card says the true start for working-tree delivery (the current files, not the last commit).
    expect(seen).toContain('The worker starts from your current files'); expect(seen).not.toContain('starts from the last commit');
    expect(await readFile(join(project, 'notes.txt'), 'utf8')).toBe('first line\nperson line\nsecond line\n');
    expect(git(project, 'rev-list', '--count', 'HEAD')).toBe('1');
    // /tasks: the task is named "Task 1" and its text shows once.
    const live = seen.lastIndexOf('Background work (live)'), tasks = seen.slice(live, seen.indexOf('↑↓ selects', live)); // one drawn frame of the window
    expect.soft(tasks, '/tasks names the task').toContain('Task 1'); expect.soft(tasks.split('append the line "second line"').length - 1, '/tasks shows the text once').toBe(1);
    // Rollback with the command the delivery line names: one card, y, the file is back.
    const rollback = /deckent task integration-rollback --scope c --run (\S+) --task (\S+)`/u.exec(seen.replace(/\s+/gu, ' ').replace(/integra tion/u, 'integration'));
    expect(rollback).not.toBeNull();
    const back = open(['task', 'integration-rollback', '--scope', 'c', '--run', rollback![1]!, '--task', rollback![2]!]);
    await walk('j2-rollback', back, [[/y\/N/u, ''], [800, 'y\r']]);
    expect(await back.closed, back.text()).toBe(0);
    expect(await readFile(join(project, 'notes.txt'), 'utf8')).toBe('first line\nperson line\n');
    // Conflict while the worker RUNS (it holds 10 s before writing): the person edits the file then. The delivery writes nothing and r prepares
    // the same /do again.
    const c = open(), cFrom = c.mark();
    await walk('j2-conflict', c, [[/Ready/, '/do JOURNEY-C append the line "third line" to notes.txt'], [800, '\r'], ...card('This folder has uncommitted changes'),
      ['Approval needed', ''], [2500, 'y'], ['admitted. Follow', '']]);
    for (const until = Date.now() + within(); !workerRunning(root);) { if (Date.now() > until) throw new Error(`the JOURNEY-C worker never started\n${c.flat(cFrom).slice(-3000)}`); await pause(200); }
    await writeFile(join(project, 'notes.txt'), 'first line\nperson line\nperson edit\n');
    // The delivery window opens by itself once the Run completes and already finds the edit: nothing is written; Ctrl+O, then r.
    await walk('j2-conflict', c, [[1500, CTRL_O], [800, ESC], [/nothing was written[\s\S]*press r/u, ''], [1500, CTRL_O], [1500, 'r'], [3000, '']]);
    expect(await readFile(join(project, 'notes.txt'), 'utf8')).toBe('first line\nperson line\nperson edit\n');
    expect(c.flat(cFrom).slice(-4000)).toContain('/do JOURNEY-C append the line "third line" to notes.txt');
    // J4
    await writeFile(join(root, 'home', 'skill.json'), JSON.stringify({ skillId: 'note-style', name: 'Note style', text: 'Add each new note as its own line at the end of notes.txt.' }));
    await writeFile(join(root, 'home', 'agent.json'), JSON.stringify({ agentId: 'note-writer', name: 'Note writer', persona: 'Adds short notes to notes.txt.', workClasses: ['small'],
      skills: [{ skillId: 'note-style' }], parentAgentId: null }));
    for (const [kind, file] of [['define-skill', 'skill.json'], ['define', 'agent.json']] as const) {
      const step = open(['agents', kind, '--input', join(root, 'home', file), '--scope', 'c']);
      await walk(`j4-${kind}`, step, card(/Apply \(y\)/u, 'y'));
      expect(await step.closed, step.text()).toBe(0);
    }
    const d = open(), dFrom = d.mark();
    await walk('j4', d, [[/Ready/, '/do JOURNEY-D append the line "agent line" to notes.txt'], [800, '\r'], ...card('This folder has uncommitted changes'), ['Approval needed', ''],
      [2500, ESC], ['Rejected', ''], [1500, ESC], [2000, '/exit\r']]);
    await d.closed;
    const bound = d.flat(dFrom); expect(bound).toMatch(/agent: (?:note-writer|Note writer)/u); expect(bound).toMatch(/skills: note-style/u);
  });

  it('J5 new projects under the same global home: G by init, H attached to the installation\'s connection; distinguishable setup choices, chat with Claude and with Codex without a manual reconcile (F2-13, F2-15, F2-17)', async () => {
    const g = await gitProject(root, 'G'); folders.push(g);
    for (const args of [['init', '--here', '--yes', '--scope', 'g'], ['models', 'login', '--connection', 'codex-cli-subscription'],
      ['models', 'connect', '--connection', 'codex-cli-subscription', '--scope', 'g', '--delegate', 'ai']]) {
      const step = open(args, g); await walk(`j5-${args[1]}-${args[3] ?? ''}`, step, [[/y\/N|Apply \(y\)|Enter confirm/u, ''], [1000, 'y']]).catch(() => undefined);
      expect(await step.closed, step.text()).toBe(0);
    }
    const t = open([], g), from = t.mark();
    const rows = await firstOpen(t);
    await dump('j5', t);
    expect.soft(rows.length, t.flat(from).slice(-3000)).toBeGreaterThan(0);
    expect.soft(new Set(rows).size, rows.join(' | ')).toBe(rows.length);
    // Claude is already signed in under this global home: the person connects it here with /provider "Connect (no key: checks the sign-in)", then
    // chats with a Codex model and with a Claude model; both answer without a reconcile or a refusal (F2-15, F2-17). Rows are chosen by filter.
    const gChat = await walk('j5-chat', t, [[1500, '/provider'], [1500, '\r'], ['Sign in with Claude ›', ''], [1500, '\r'], ['Connect (no key', ''], [1500, DOWN], [800, '\r'],
      ['Connected: Sign in with Claude', ''], [1500, '\r'], [1500, ESC], [2000, '/model'], [1500, '\r'], ['codex-cli-subscription ›', ''], [1000, 'codex'], [1000, '\r'],
      ['GPT-6-Sol', ''], [1000, '6-sol'], [1500, '\r'], ['Use as Brain model (this project)', ''], [800, '\r'], ['make it my default', ''], [800, '\r'], [2500, 'JOURNEY-G-CODEX hello'], [600, '\r'],
      ['answered g-codex.', ''], [2000, '/model'], [1500, '\r'], ['codex-cli-subscription ›', ''], [1000, 'claude'], [1000, '\r'], ['Claude Sonnet 5.5', ''], [1000, 'sonnet'], [1500, '\r'],
      ['Use as Brain model (this project)', ''], [800, '\r'], ['make it my default', ''], [800, '\r'], [2500, 'JOURNEY-G-CLAUDE hello'], [600, '\r'], ['answered g-claude.', ''],
      [1500, '/exit\r']]).then(() => null, (error: Error) => error.message.slice(0, 2000));
    await t.close();
    // Soft, so the attached project H below is still walked when G is red.
    expect.soft(gChat, 'G chat with Codex then Claude').toBeNull();
    expect.soft(t.flat(from)).not.toMatch(denied);
    // F2-15 as the owner met it: a new folder H with no installation. Bare `deckent` offers a session on this installation's registered source (C)
    // and its connection; yes attaches H (project-attachment.json, the source's profiles as schemaVersion 3 with a model-use lease) and opens the
    // terminal there. The first chat turn runs on the leased Claude model; Codex (signed in above) is connected with /provider and answers too.
    const h = await gitProject(root, 'H'); folders.push(h);
    const a = open([], h), aFrom = a.mark();
    await walk('j5-attach', a, card('Open a session in this folder?', 'y'));
    const attachedRows = await firstOpen(a);
    expect.soft(new Set(attachedRows).size, attachedRows.join(' | ')).toBe(attachedRows.length);
    const attachment = JSON.parse(await readFile(join(h, '.deckent', 'project-attachment.json'), 'utf8')) as { scopeId?: string };
    const profiles = (JSON.parse(await readFile(join(h, '.deckent', 'config.json'), 'utf8')).provider_invocation_profiles?.profiles ?? []) as
      { schemaVersion: number; scopeId: string; useLeaseId?: string; reference: { providerId: string } }[];
    const leased = profiles.filter(profile => profile.reference.providerId === 'claude-cli-subscription');
    expect(leased.length, JSON.stringify(profiles.map(profile => profile.reference))).toBeGreaterThan(0);
    for (const profile of leased) expect(profile).toMatchObject({ schemaVersion: 3, scopeId: attachment.scopeId, useLeaseId: expect.any(String) });
    await walk('j5-attach-chat', a, [[1500, 'JOURNEY-H-CLAUDE hello'], [600, '\r'], ['answered h-claude.', ''], [2000, '/provider'], [1500, '\r'], ['Sign in with ChatGPT', ''], [1000, 'chatgpt'],
      [1000, '\r'], ['Connect (no key', ''], [1500, DOWN], [800, '\r'], [/Connected: Sign in with ChatGPT/u, ''], [1500, '\r'], [1500, ESC], [2000, '/model'], [1500, '\r'],
      ['codex-cli-subscription ›', ''], [1000, 'codex'], [1000, '\r'], ['GPT-6-Sol', ''], [1000, '6-sol'], [1500, '\r'], ['Use as Brain model (this project)', ''], [800, '\r'],
      ['make it my default', ''], [800, '\r'], [2500, 'JOURNEY-H-CODEX hello'], [600, '\r'], ['answered h-codex.', ''], [1500, '/exit\r']]);
    await a.closed;
    expect(a.flat(aFrom)).not.toMatch(denied);
  }, 480_000);
});
