import { execFileSync } from 'node:child_process';
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
const pause = (ms: number) => new Promise(resolveWait => setTimeout(resolveWait, ms));
const dump = async (name: string, s: PtySession) => { if (OUT) await writeFile(join(OUT, `${name}.txt`), s.text()); };
/** Each wait looks only at output after the previous step's keys (an earlier frame never answers a later card); a number is a plain pause. */
async function walk(name: string, s: PtySession, steps: readonly Step[]) {
  let from = s.mark();
  try { for (const [wait, keys] of steps) { if (typeof wait === 'number') await pause(wait); else await s.waitFor(wait, from); from = s.mark(); await s.type(keys); } }
  finally { await dump(name, s); }
}
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
const realm = await nativeAgentRealmAvailable('tests/e2e/owner-journey.test.ts', 'owner journey');

describe.skipIf(!realm)('owner journey FINAL-CHECK-2 (synthetic-person in a disposable install)', { timeout: 300_000 }, () => {
  let root = '', project = '', global = '', env: NodeJS.ProcessEnv = {};
  const git = (cwd: string, ...args: string[]) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8' }).trim();
  const open = (args: string[] = [], cwd = project) => { const s = openPtySession([process.execPath, cli, ...args], cwd, env); sessions.push(s); return s; };
  const deckent = (args: string[], cwd = project) => execFileSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8', timeout: 60_000 });

  beforeAll(async () => {
    // A private parent: the product refuses a personal sign-in store under a world-writable /tmp. This checkout's ignored .pack folder.
    const parent = resolve(process.env['DECKENT_JOURNEY_ROOT'] ?? '.pack/journey'); await mkdir(parent, { recursive: true, mode: 0o700 });
    root = await mkdtemp(join(parent, 'j-'));
    const home = join(root, 'home'), bin = join(root, 'bin'); global = join(root, 'global'); project = join(root, 'C');
    for (const dir of [home, global, bin, project]) await mkdir(dir, { recursive: true, mode: 0o700 });
    env = personEnv({ PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, DECKENT_GLOBAL_HOME: global, TERM: 'xterm-256color', NO_COLOR: '1',
      DECKENT_LANGUAGE: 'en', LANG: 'C.UTF-8' });
    // The fakes are CommonJS scripts; this checkout's package.json says "module", so their folder says otherwise.
    await writeFile(join(bin, 'package.json'), '{"type":"commonjs"}');
    // One scripted turn per marker: the Brain call (no tools) answers a plan for its intent, the worker call (tools) writes the file and reports.
    const notes = (...lines: string[]) => ({ name: 'write_file', arguments: { path: 'notes.txt', content: lines.map(line => `${line}\n`).join('') } });
    const report = JSON.stringify({ schemaVersion: 1, summary: 'appended the line', changedFiles: ['notes.txt'], checks: [], openIssues: [] });
    const turns = [
      { when: 'JOURNEY-A', textFrom: BRAIN, calls: [notes('first line', 'person line', 'second line')], answer: report },
      { when: 'JOURNEY-C', textFrom: BRAIN, calls: [notes('first line', 'person line', 'third line')], answer: report },
      { when: 'JOURNEY-D', textFrom: BRAIN, calls: [notes('first line', 'person line', 'agent line')], answer: report },
      { when: 'JOURNEY-HELLO', calls: [{ name: 'write_file', arguments: { path: 'hello.txt', content: 'hello\n' } }], answer: 'wrote hello.txt' },
    ];
    await fakeCli(bin, 'claude-code-stream-json', 'claude', { turns });
    await fakeCli(bin, 'codex-jsonl', 'codex', { turns });
    git(project, 'init', '-q'); git(project, 'config', 'user.email', 'person@example.invalid'); git(project, 'config', 'user.name', 'Person');
    await writeFile(join(project, 'notes.txt'), 'first line\n'); git(project, 'add', '.'); git(project, 'commit', '-qm', 'init');
    const init = open(['init', '--here', '--yes', '--scope', 'c']);
    await init.closed; await dump('init', init);
    // First open: onboarding with the Claude subscription sign-in (the fake CLI's own `auth login`), as the owner's C was set up.
    const t = open();
    await walk('onboarding', t, [['Choose a profile to preview', CTRL_O], [800, '\r'], ...card('Confirm to complete'), ...card('Give me these rights'), ...card('rights are given'),
      ...card('No model is connected yet'), ...card('Sign in with Claude · no extra charge ›'), ...card('Sign in with its CLI and connect'), ...card("Deckent's own login directory"),
      ...card('who besides you may use this login', DOWN.repeat(2)), [800, '\r'], [1500, '\u001b[A\u001b[A'], [800, '\r'], ...card('Let ai use your', 'y'), ...card('Model connected'), ...card('Use my claude subscription'), ...card('Declare work kind coding on claude', 'y'),
      ...card('Set up worker pool', 'y'), ...card('Project instructions', ESC), [3000, '/exit\r']]);
    await t.closed;
    // NF-2: the onboarding's subscription worker choice writes the first work kind on that connection (no CLI twin needed).
    expect(JSON.parse(await readFile(join(project, '.deckent', 'config.json'), 'utf8')).admission?.registry?.kinds?.map((row: { kind: string }) => row.kind), t.text().slice(-3000)).toEqual(['coding']);
  }, 300_000);
  afterAll(async () => {
    for (const s of sessions.splice(0)) await s.close();
    // Each project's terminal started its runtime service in the background; the disposable install stops them before its folder goes.
    for (const folder of [project, join(root, 'G')]) try { deckent(['runtime', 'shutdown', '--force', '--reason', 'journey test end'], folder); } catch { /* not running */ }
    if (root && !process.env['JOURNEY_KEEP']) await rm(root, { recursive: true, force: true });
  });

  it('J1 + J3 chat on the connected Claude subscription: /model (F2-1), first turn verifies tools, /provider, a careful-mode edit card and Esc', async () => {
    const t = open();
    await walk('j1-set', t, [[/Ready/, '/model'], [1500, '\r'], ['Claude Sonnet 5.5 (Sign in', ''], [800, DOWN.repeat(3)], [600, '\r'], ['Use as Brain model (this project)', ''],
      [800, '\r'], ['make it my default', ''], [800, '\r'], [3000, '/model'], [1500, '\r'], ['Claude Opus 5.5 (Sign in', ''], [800, DOWN.repeat(2)], [600, '\r'],
      ['Use as Brain model (this project)', ''], [800, DOWN.repeat(2)], [600, '\r'], ['now plans /do work', ''], [1500, '/exit\r']]);
    await t.closed;
    // "This session, and make it my default" is offered first; "Use as Brain model (your default)" reaches the host port and closes (F2-1).
    const scope = t.flat(); expect(scope.indexOf('This session, and make it my default')).toBeLessThan(scope.indexOf('This session only'));
    expect(JSON.parse(await readFile(join(global, 'config.json'), 'utf8')).brain_planner?.reference).toMatchObject({ providerId: 'claude-cli-subscription', modelId: 'opus-5-5' });
    // Owner checklist 1-3: no "cannot use tools" band, /model shows the chat model and the Brain mark without a USD budget row, the first turn
    // verifies the tools and /provider then says verified.
    const s = open(), from = s.mark();
    await walk('j1', s, [[/Ready/, '/model'], [1500, '\r'], ['Models · c', ''], [2000, DOWN.repeat(2)], [2500, ESC], [1500, 'hello'], [600, '\r'], ['agent completed', ''], [1500, '/provider'], [1500, '\r'],
      ['Sign in with Claude ›', ''], [2500, ESC], [1500, '/exit\r']]);
    await s.closed;
    const seen = s.flat(from);
    expect(seen).not.toContain('This model cannot use tools here');
    expect(seen).toContain('Claude Sonnet 5.5 (Sign in with Claude) · default'); expect.soft(seen, 'Brain mark on /model').toContain('plans /do work (Brain model)');
    expect(seen).not.toMatch(/USD|\$\s?\d/u);
    expect(seen).toContain('claude-sonnet-5-5: Agent prerequisites verified');
    // J3
    const m = open(), mFrom = m.mark();
    // The mode window (typed /mode arguments are not used in the terminal): careful, then back to full auto for the /do journeys.
    await walk('j3', m, [[/Ready/, '/mode'], [1500, '\r'], ['careful', ''], [1500, DOWN], [800, '\r'], [3000, 'JOURNEY-HELLO write hello into hello.txt'], [600, '\r'],
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
      [2500, DOWN], [800, 'x'], [/already finished|nothing to cancel/u, ''], [1500, ESC], [1500, '/exit\r']]);
    await t.closed;
    const seen = t.flat(from), plan = seen.slice(seen.indexOf('Approval needed'), seen.indexOf('admitted. Follow'));
    // The plan card: no money ceiling line for a subscription and no internal codes (F2-12); no worker card after y; one written-to-files delivery.
    expect(plan).not.toMatch(/\$\s?\d|APPROVAL_REQUIRED|[0-9a-f]{64}/u);
    expect(seen.slice(seen.indexOf('admitted. Follow'))).not.toContain('Approval needed');
    expect(seen).toContain('the change is written into your files (no commit');
    expect(await readFile(join(project, 'notes.txt'), 'utf8')).toBe('first line\nperson line\nsecond line\n');
    expect(git(project, 'rev-list', '--count', 'HEAD')).toBe('1');
    // /tasks: the task is named "Task 1" and its text shows once.
    const tasks = seen.slice(seen.lastIndexOf('Background work'));
    expect(tasks).toContain('Task 1'); expect(tasks.split('append the line "second line"').length - 1).toBe(1);
    // Rollback with the command the delivery line names: one card, y, the file is back.
    const rollback = /deckent task integration-rollback --scope c --run (\S+) --task (\S+)`/u.exec(seen.replace(/\s+/gu, ' ').replace(/integra tion/u, 'integration'));
    expect(rollback).not.toBeNull();
    const back = open(['task', 'integration-rollback', '--scope', 'c', '--run', rollback![1]!, '--task', rollback![2]!]);
    await walk('j2-rollback', back, [[/y\/N/u, ''], [800, 'y\r']]);
    expect(await back.closed, back.text()).toBe(0);
    expect(await readFile(join(project, 'notes.txt'), 'utf8')).toBe('first line\nperson line\n');
    // Conflict: the person edits the file after the worker's base; the delivery writes nothing and r prepares the same /do again.
    const c = open(), cFrom = c.mark();
    await walk('j2-conflict', c, [[/Ready/, '/do JOURNEY-C append the line "third line" to notes.txt'], [800, '\r'], ...card('This folder has uncommitted changes'),
      ['Approval needed', ''], [2500, 'y'], ['admitted. Follow', ''], [1500, CTRL_O], [800, ESC], ['awaiting delivery', '']]);
    await writeFile(join(project, 'notes.txt'), 'first line\nperson line\nperson edit\n');
    await walk('j2-conflict', c, [[1000, '/deliver'], [1500, '\r'], ['y check, prepare and deliver', ''], [2500, 'y'], [/nothing (?:is |was )?written|none is written|not written/u, ''], [2000, 'r'],
      [3000, '']]);
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
      [2500, ESC], [2000, '/exit\r']]);
    await d.closed;
    const bound = d.flat(dFrom); expect(bound).toContain('Note writer'); expect(bound).toContain('note-style');
  });

  it('J5 a new project G under the same global home: distinguishable setup choices, chat with Claude and with Codex without a manual reconcile (F2-13, F2-15, F2-17)', async () => {
    const g = join(root, 'G'); await mkdir(g, { mode: 0o700 });
    git(g, 'init', '-q'); git(g, 'config', 'user.email', 'person@example.invalid'); git(g, 'config', 'user.name', 'Person');
    await writeFile(join(g, 'notes.txt'), 'first line\n'); git(g, 'add', '.'); git(g, 'commit', '-qm', 'init');
    for (const args of [['init', '--here', '--yes', '--scope', 'g'], ['models', 'login', '--connection', 'codex-cli-subscription'],
      ['models', 'connect', '--connection', 'codex-cli-subscription', '--scope', 'g', '--delegate', 'ai']]) {
      const step = open(args, g); await walk(`j5-${args[1]}-${args[3] ?? ''}`, step, [[/y\/N|Apply \(y\)|Enter confirm/u, ''], [1000, 'y']]).catch(() => undefined);
      expect(await step.closed, step.text()).toBe(0);
    }
    const t = open([], g), from = t.mark();
    // The first open walks the onboarding cards as the person: the profile and rights are confirmed, every other step is left for later; the
    // worker-kind card is read (F2-13: each subscription choice names its model, so no two rows read the same).
    const rows: string[] = [];
    for (let step = 0; step < 10; step++) {
      const mark = t.mark();
      if (!await t.waitFor(/Step \d+\/\d+/u, mark, 15_000).then(() => true, () => false)) break;
      await pause(1500);
      const shown = t.flat(mark);
      if (/Use my \w+ subscription/u.test(shown)) rows.push(...[...shown.matchAll(/(?:>|›)?\s*(Use my [^>›]*?subscription[^>›]*?)(?=\s+(?:Use my|Change|Enter)|$)/gu)].map(row => row[1]!.trim()));
      await t.type(/Give me these rights|rights are given|Continue opens this profile|Confirm to complete/u.test(shown.slice(-1500)) ? '\r' : ESC);
    }
    await dump('j5', t);
    expect.soft(rows.length, t.flat(from).slice(-3000)).toBeGreaterThan(1);
    expect.soft(new Set(rows).size, rows.join(' | ')).toBe(rows.length);
    // Claude is already signed in under this global home: the person connects it here with /provider "Connect (no key: checks the sign-in)", then
    // chats with a Codex model and with a Claude model; both answer without a reconcile or a refusal (F2-15, F2-17).
    await walk('j5-chat', t, [[1500, '/provider'], [1500, '\r'], ['Sign in with Claude ›', ''], [1500, '\r'], ['Connect (no key', ''], [1500, DOWN], [800, '\r'],
      ['Connected: Sign in with Claude', ''], [1500, '\r'], [1500, ESC], [2000, '/model'], [1500, '\r'], ['codex-cli-subscription ›', ''], [1000, DOWN], [600, '\r'], ['GPT-6-Sol', ''],
      [1000, 'sol'], [1500, '\r'], ['Use as Brain model (this project)', ''], [800, '\r'], ['make it my default', ''], [800, '\r'], [2500, 'hello codex'], [600, '\r'],
      ['agent completed', ''], [2000, '/model'], [1500, '\r'], ['codex-cli-subscription ›', ''], [1000, '\r'], ['Claude Sonnet 5.5', ''], [1000, 'sonnet'], [1500, '\r'],
      ['Use as Brain model (this project)', ''], [800, '\r'], ['make it my default', ''], [800, '\r'], [2500, 'hello claude'], [600, '\r'], ['agent completed', ''],
      [1500, '/exit\r']]);
    await t.closed;
    expect(t.flat(from)).not.toMatch(/PROJECT_ATTACHMENT_DENIED|installation owner|only with your approval|Unexpected operation failure/u);
  });
});
