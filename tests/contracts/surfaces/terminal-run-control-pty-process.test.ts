import { rm, writeFile } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { clearConfigCache, productResourcePath } from '#platform/index.js';
import { workspacePatchFixture, type FixtureTracker } from '../support/workspace-patch-fixture.js';
import { inPty, type Step } from '../support/pty-steps.js';

// Y1 at the real boundary: the built Workline on its own controlling PTY, the built cli-terminal ledger ports and the real configured
// composition (inventory, run inspection, the CLI's in-process lifecycle application, policy and ledger). The Run is a real reserved Run.
const program = resolve('tests/fixtures/run-control-application.mjs');
const track: FixtureTracker = { roots: [], cleanup: [] };
afterEach(async () => {
  for (const close of track.cleanup.splice(0).reverse()) await close();
  clearConfigCache(); for (const root of track.roots.splice(0)) await rm(root, { recursive: true, force: true });
});
/** The scope's grants; `cancel` on the Run is the authority hold and close use (`run hold|close`), `reserve` the one resume uses. */
async function grant(f: Awaited<ReturnType<typeof workspacePatchFixture>>, runActions: readonly string[]) {
  const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  await writeFile(productResourcePath(f.runtime.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'run-control', restrictions: [], grants: [
    { id: 'run', effect: 'allow', actions: runActions, scopes: ['s'], principals, resource: { kind: 'run', ids: ['r'] } },
    { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
    { id: 'attempt', effect: 'allow', actions: ['read-output'], scopes: ['s'], principals, resource: { kind: 'attempt', ids: 'all' } },
    { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals, resource: { kind: 'scope', ids: ['s'] } },
  ] }), { mode: 0o600 });
}
const plain = (output: string) => stripVTControlCharacters(output);
const squeeze = (text: string) => plain(text).replace(/[│┃\s]+/gu, '');
/** Evidence capture for the card's proof folder (only when Y1_CAPTURE_DIR names one). */
const capture = async (name: string, output: string) => { const dir = process.env['Y1_CAPTURE_DIR']; if (dir) await writeFile(join(dir, name), plain(output)); };

describe.skipIf(process.platform !== 'linux' || !process.env['DECKENT_TEST_DOCKER_IMAGE'])('terminal Runs window keys — real controlling PTY, composition and ledger', { timeout: 240_000 }, () => {
  it('h y holds, a close the service refuses (a task is still being evaluated) shows its typed reason, r y resumes; the ledger records both with the shown command ids', async () => {
    // The attempt runs (the inventory lists dispatched attempts) and is not evaluated yet: the Run is running with a task under evaluation.
    const f = await workspacePatchFixture(track); await f.run(); await grant(f, ['create', 'reserve', 'inspect', 'cancel']);
    const before = (await f.runtime.store.loadRun('s', 'r'))!;
    expect(before.state.kind).toBe('running');
    // TERMINAL-SABIT-DUZEN slice 2: each confirmation card shows its keys only once they count (armed); y waits for them ('next').
    const steps: Step[] = [['READY', '/runs\r'], ['h hold', 'h'], ['Hold run', ''], ['Enter/Esc keep (default)', 'y', 'next'], ['hold recorded, now parked (revision', 'c'],
      ['Close parked run', ''], ['Enter/Esc keep (default)', 'y', 'next'], ['(code: RUN_DECISION_NOT_READY)', 'r'],
      ['Resume run', ''], ['Enter/Esc keep (default)', 'y', 'next'], ['resume recorded, now running (revision', '']];
    const result = await inPty(program, f.project, f.options.env, 'en', steps); await capture('runs-hold-close-resume-en.txt', result.output);
    const after = (await f.runtime.store.loadRun('s', 'r'))!;
    expect(after.state.kind).toBe('running'); expect(after.revision).toBe(before.revision + 2); // hold + resume; the refused close wrote nothing
    const output = plain(result.output), ids = [...output.matchAll(/Command (terminal-run-(?:hold|resume)-[0-9a-f-]{36})/gu)].map(match => match[1]!);
    expect(new Set(ids).size).toBe(2);
    for (const commandId of ids) expect(await f.runtime.store.loadRunReceipt!('s', commandId)).not.toBeNull();
    expect(squeeze(result.output)).toContain(squeeze('Run r hold recorded, now parked (revision'));
  });

  it('without the run cancel grant the hold is refused by policy, in Turkish in a TR session; nothing changes', async () => {
    const f = await workspacePatchFixture(track); await f.run(); await grant(f, ['create', 'reserve', 'inspect']);
    const before = (await f.runtime.store.loadRun('s', 'r'))!;
    const result = await inPty(program, f.project, f.options.env, 'tr', [['READY', '/runs\r'], ['h beklet', 'h'], ['bekletilsin mi', ''], ['Enter/Esc koru (varsayılan)', 'y', 'next'], ['(kod: ', '']]);
    await capture('runs-hold-policy-denied-tr.txt', result.output);
    const after = (await f.runtime.store.loadRun('s', 'r'))!;
    expect(after.revision).toBe(before.revision); expect(after.state.kind).toBe('running');
    const code = /\(kod: ([A-Z_]+)\)/u.exec(plain(result.output))?.[1];
    expect(code).toBe('POLICY_DENIED');
  });
});
