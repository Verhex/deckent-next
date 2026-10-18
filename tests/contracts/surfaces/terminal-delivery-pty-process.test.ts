import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hostname, userInfo } from 'node:os';
import { promisify, stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateTask, inspectConfiguredWorkspaceIntegration } from '../../../src/index.js';
import { DatabaseSync } from 'node:sqlite';
import { DockerSupervisor } from '#adapters/index.js';
import { clearConfigCache, productResourcePath } from '#platform/index.js';
import { readyDeliveryFixture, type FixtureTracker } from '../support/workspace-patch-fixture.js';
import { DRIVER, inPty as runInPty, type Step } from '../support/pty-steps.js';

// TESLIM-PENCERESI at the real boundary: the built Workline on its own controlling PTY with the built delivery port over the real configured
// composition and real Git (Docker executes the coding attempt). Only the Run view that triggers the window is a fixture ledger port.
const execute = promisify(execFile);
const program = resolve('tests/fixtures/delivery-window-application.mjs');
const inPty = (project: string, env: NodeJS.ProcessEnv, mode: string, steps: readonly Step[], stdin = 'tty') => runInPty(program, project, env, mode, steps, stdin);
const track: FixtureTracker = { roots: [], cleanup: [] };
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of track.cleanup.splice(0).reverse()) await close();
  clearConfigCache(); for (const root of track.roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const CTRL_O = '\u000f', ESC = '\u001b';
const WINDOW = 'Delivery · Ship useful change', READY_HINT = 'y check, prepare and deliver';
const CONFIRM_BODY = 'The confirmation card differs from what was shown';
/** /do admits the fixture Run; its result window is closed explicitly; the delivery window then appears by itself (composer keeps focus). */
const opening: readonly Step[] = [['READY', '/do ship it\r'], ['PLAN-RESULT', CTRL_O], ['WINDOW-FOCUS', ESC]];

/** Ctrl+O moves focus to the waiting window; the decision key is typed only once the window counts keys again: after the switch it re-arms and
 * shows its key hints only then (TERMINAL-SABIT-DUZEN slice 2; `fresh`: after this Ctrl+O). */
const decide = (key: string, after = WINDOW, armed = READY_HINT): readonly Step[] => [[after, CTRL_O], [armed, key, 'fresh']];

/** The fixture's grants plus `inspect` on the scope: the window resolves the newest attempt through the inventory, as `deckent task … --run --task` does. */
async function grant(f: Awaited<ReturnType<typeof readyDeliveryFixture>>, attempt: readonly string[]) {
  const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  await writeFile(productResourcePath(f.runtime.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'delivery-window', restrictions: [], grants: [
    { id: 'run', effect: 'allow', actions: ['create', 'reserve', 'inspect'], scopes: ['s'], principals, resource: { kind: 'run', ids: ['r'] } },
    { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
    { id: 'attempt', effect: 'allow', actions: attempt, scopes: ['s'], principals, resource: { kind: 'attempt', ids: 'all' } },
    { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals, resource: { kind: 'scope', ids: ['s'] } },
  ] }), { mode: 0o600 });
}
async function fixture(options: Parameters<typeof readyDeliveryFixture>[1] = {}) {
  const f = await readyDeliveryFixture(track, options);
  await grant(f, ['read-output', 'prepare-integration', 'deliver-integration']);
  const refs = async () => ({ refs: await f.git('for-each-ref', '--format=%(refname) %(objectname)'), objects: await f.git('count-objects', '-v') });
  const source = async () => ({ head: await f.git('rev-parse', 'HEAD'), index: (await readFile(join(f.project, '.git/index'))).toString('base64'),
    status: await f.git('--no-optional-locks', 'status', '--porcelain') });
  const deliveries = async () => (await f.git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/deckent/deliveries/')).split('\n').filter(Boolean);
  return { ...f, refs, source, deliveries };
}

describe.skipIf(process.platform !== 'linux' || !process.env['DECKENT_TEST_DOCKER_IMAGE'])('terminal delivery window — real controlling PTY, composition and Git', { timeout: 240_000 }, () => {
  it('appears by itself; Ctrl+O then y checks, prepares and delivers one dedicated ref; source HEAD, index and worktree unchanged', async () => {
    const f = await fixture(), before = await f.source();
    expect(await f.deliveries()).toEqual([]);
    const result = await inPty(f.project, f.options.env, 'window', [...opening, ...decide('y'), ['branches and working tree unchanged.', '']]);
    expect(result.output).toContain(WINDOW); expect(result.output).toContain('Integration check: affected files match base');
    expect(result.output).toContain('note.txt | +1 -1'); expect(result.output).toContain('Writes only a dedicated reference under refs/deckent/deliveries/');
    expect(result.output).not.toContain('y adopt into the selected branch'); // no execution.adoption.targets: no branch choice
    // DECISIONS §1 on real data: the port's card (Git-described file set, effective base) matched the shown one, so one y sufficed.
    expect(result.output).not.toContain(CONFIRM_BODY);
    const [line] = await f.deliveries(); expect(line).toBeDefined();
    const [ref, commit] = line!.split(' ');
    expect(result.output).toContain(`Delivered: commit ${commit} → ${ref}`);
    expect(await f.git('rev-parse', `${commit}^`)).toBe(f.base);
    expect((await f.git('show', '--name-only', '--format=', commit!)).split('\n').sort()).toEqual(['added.txt', 'note.txt', 'removed.txt']);
    expect(await f.source()).toEqual(before);
  });

  it('n writes nothing: no candidate, no reference, no object', async () => {
    const f = await fixture(), before = await f.refs(), source = await f.source();
    const result = await inPty(f.project, f.options.env, 'window', [...opening, ...decide('n'), ['Delivery left waiting: Ship useful change', '']]);
    expect(result.output).toContain(WINDOW);
    expect(await f.refs()).toEqual(before); expect(await f.source()).toEqual(source);
  });

  it('a source changed after the patch is refused in human words with the next step; nothing is written', async () => {
    const f = await fixture();
    // The owner commits a change to an affected file after the patch was made: the base the patch was made on is no longer the source.
    await writeFile(join(f.project, 'note.txt'), 'changed by the owner\n'); await f.git('-c', 'core.hooksPath=/dev/null', 'commit', '-qam', 'moved base');
    const before = await f.refs();
    const result = await inPty(f.project, f.options.env, 'window', [...opening, [WINDOW, ''], ...decide('y', 'Next: ', 'Enter/Esc close'), ['Enter/Esc close', '']]);
    expect(result.output).toMatch(/ERR PATCH_(?:BASE_ADVANCED|CONFLICT)/u);
    expect(await f.refs()).toEqual(before); expect(await f.deliveries()).toEqual([]);
    // No queue is composed in this window: the queue's re-prepare key is not offered, closing is (terminal-delivery-window covers the offer).
    expect(result.output).not.toContain('r: re-prepare on current base');
  });

  it('with a configured target, adoption needs a second y: n keeps the branch, y moves it to the delivered commit', async () => {
    for (const answer of ['n', 'y'] as const) {
      const f = await fixture({ adoptionTargets: ['refs/heads/adopted'] });
      await f.git('branch', 'adopted', f.base);
      // The coding attempt is evaluated (accepted) first: adoption requires the accepted Task, as on the CLI.
      await grant(f, ['read-output', 'evaluate']);
      await evaluateTask(f.project, { schemaVersion: 1, commandId: 'evaluation', identity: f.identity, expectedRevision: (await f.runtime.store.loadRun('s', 'r'))!.revision }, f.options);
      await grant(f, ['read-output', 'prepare-integration', 'deliver-integration', 'adopt-integration']);
      const source = await f.source();
      const steps: Step[] = [...opening, ...decide('y'), ['y adopt into the selected branch', answer]];
      steps.push(answer === 'y' ? ['Adopted into refs/heads/adopted', ''] : ['Not adopted into a branch; the delivery stays at', '']);
      const result = await inPty(f.project, f.options.env, 'window', steps);
      expect(result.output).toContain('After delivery, adopting into a branch is a separate choice: refs/heads/adopted');
      const [line] = await f.deliveries(); const commit = line!.split(' ')[1]!;
      expect(await f.git('rev-parse', 'refs/heads/adopted')).toBe(answer === 'y' ? commit : f.base);
      if (answer === 'y') expect(result.output).toContain(`Adopted: refs/heads/adopted ${f.base} → ${commit}`);
      expect(result.output).not.toContain(CONFIRM_BODY); // both port cards matched the window's shown consent
      expect((await f.source()).head).toBe(source.head); expect((await f.source()).status).toBe(source.status);
      for (const close of track.cleanup.splice(0).reverse()) await close();
    }
  });

  it('Y1: a required verification is chosen in the window; the real adoption binds that Run and shows the command ids for rollback', async () => {
    const target = 'refs/heads/adopted', f = await fixture({ adoptionTargets: [target] });
    await f.git('branch', 'adopted', f.base);
    await grant(f, ['read-output', 'evaluate']);
    await evaluateTask(f.project, { schemaVersion: 1, commandId: 'evaluation', identity: f.identity, expectedRevision: (await f.runtime.store.loadRun('s', 'r'))!.revision }, f.options);
    // The installation requires a verification Run of kind `verify` (process exit 0); the kind runs on the same pinned image.
    const config = JSON.parse(await readFile(f.configPath, 'utf8'));
    const profile = structuredClone(config.admission.registry.profiles[0]); profile.id = 'fixture-verify'; profile.parameters.argv = ['node', '-e', 'process.exit(0)'];
    config.admission.registry.profiles.push(profile); config.admission.registry.kinds.push({ kind: 'verify', profile: { id: profile.id, version: 1 } });
    config.execution.adoption.verification = { kind: 'verify', required: true, criteria: [{ evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };
    await writeFile(f.configPath, JSON.stringify(config)); clearConfigCache();
    const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
    await writeFile(productResourcePath(f.runtime.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'verify-window', restrictions: [], grants: [
      { id: 'run', effect: 'allow', actions: ['create', 'reserve', 'inspect'], scopes: ['s'], principals, resource: { kind: 'run', ids: ['r', 'v'] } },
      { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
      { id: 'attempt', effect: 'allow', actions: ['execute', 'read-output', 'evaluate', 'prepare-integration', 'deliver-integration', 'adopt-integration'], scopes: ['s'], principals,
        resource: { kind: 'attempt', ids: 'all' } },
      { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals, resource: { kind: 'scope', ids: ['s'] } },
    ] }), { mode: 0o600 });
    track.cleanup.push(async () => {
      const bound = (await f.runtime.store.loadRun('s', 'v'))?.bindings[0]?.identity, record = bound && await f.runtime.store.loadBoundDispatch(bound);
      if (record) { const supervisor = await DockerSupervisor.restoreProfile(record.profile); await supervisor.cancel(record.request); await supervisor.release(record.request); }
    });
    const result = await inPty(f.project, f.options.env, 'verify', [...opening, ...decide('y'), ['y adopt into the selected branch', 'y'],
      ['Run v · task check · accepted', 'y'], ['Adopted: refs/heads/adopted', '']]);
    const dir = process.env['Y1_CAPTURE_DIR'];
    if (dir) await writeFile(join(dir, 'deliver-adopt-verified-en.txt'), stripVTControlCharacters(result.output));
    const [line] = await f.deliveries(), commit = line!.split(' ')[1]!;
    expect(await f.git('rev-parse', target)).toBe(commit);
    expect(result.output).toContain('Verification for refs/heads/adopted: choose an accepted Run of kind verify');
    const db = new DatabaseSync(productResourcePath(f.runtime.layout, 'ledger'), { readOnly: true });
    let rows: { command_id: string; intent: string }[];
    try { rows = db.prepare('SELECT command_id, intent FROM workspace_adoptions').all() as never; } finally { db.close(); }
    expect(rows).toHaveLength(1);
    const intent = JSON.parse(rows[0]!.intent), adoptionId = rows[0]!.command_id;
    expect(intent).toMatchObject({ command: { verificationRunId: 'v', verificationKind: 'verify', targetRef: target }, verification: { runId: 'v', kind: 'verify', commit } });
    // BETA-BELGE rollback gap: the adoption's own command id (and the delivery's) are in the window's result line.
    const flat = stripVTControlCharacters(result.output).replace(/[│┃\s]+/gu, '');
    expect(adoptionId).toMatch(/^terminal-adopt-/u);
    expect(flat).toContain(`verifiedbyRunv·adoptioncommand${adoptionId}`);
    expect(flat).toContain(`deliverycommand${intent.command.deliveryCommandId}`);
  });

  it('a session that is not a verified terminal is refused before any candidate is prepared, even when the answer would be yes', async () => {
    const f = await fixture(), before = await f.refs();
    const { stdout } = await execute('python3', ['-c', DRIVER, JSON.stringify([process.execPath, program, 'port-direct']), JSON.stringify([['"response"', '']]), 'piped-input'],
      { cwd: f.project, env: { ...process.env, ...f.options.env }, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    const output = (JSON.parse(stdout) as { output: string }).output, line = output.split(/\r?\n/u).find(value => value.startsWith('{"response"'));
    expect(JSON.parse(line!)).toEqual({ response: { ok: false, code: 'DELIVERY_INTERACTIVE_REQUIRED' } });
    expect(await f.refs()).toEqual(before);
    expect((await inspectConfiguredWorkspaceIntegration(f.project, { schemaVersion: 1, identity: f.identity, commandId: 'direct-candidate' }, f.options)).status).toBe('absent');
  });
});
