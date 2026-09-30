import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeModeRuntimes, modeRuntime, rule } from '../support/agent-turn-modes.js';
import { measureTestShellHost } from '../../fixtures/shell-host.js';

// Astra 2192 R9 (P2, prompt accuracy — enforcement unchanged): the v6 open-shell note said the configuration file stays sealed and a write
// to it fails, but an owner-approved call of a full-access turn opens its existing content (`shellWritePosture('owner-approved')`: the write
// floor, in that turn the configuration file, writable; the open bubblewrap view binds the existing file writable). The note now separates
// the structural hard floor (state, policy, credentials) from the configuration's per-call approval rule. A positive/negative pair on the
// real runtime service and real bubblewrap: approved → card, ok, bytes appended; autonomous (mode-eligible, full access lowers the card) →
// no card, read-only file system, bytes unchanged. Both turns get the same prompt line, and it is true of both.
afterEach(closeModeRuntimes);
const measured = await measureTestShellHost();
const bwrapReady = measured.bubblewrap.status === 'available';
const FULL_ACCESS = rule('full-access', 'permission-mode', ['full-access'], 'allow', false, ['set']);
const APPEND = "printf '\\n' >> .deckent/config.json";
const SEALED = 'Deckent\'s own state, policy and credential files stay sealed: they are hidden or read-only, and a write to them fails.';
const CONFIG = 'Its configuration file is read-only unless the owner approves the call: an approved call can change its existing content.';

async function configWrite(eligible: boolean, fullAccess: boolean) {
  const grants = [rule('shell-tool', 'agent-tool', ['run_shell'], 'require-approval', eligible), rule('shell-run', 'operation', ['host.shell.run'], 'allow'), FULL_ACCESS];
  const f = await modeRuntime({ grants, mode: null, dataRoot: '.deckent/data', shell: { schemaVersion: 1, realm: 'require-sandbox' } });
  const path = join(f.project, '.deckent/config.json'), before = await readFile(path, 'utf8');
  const result = await f.call('run_shell', { command: APPEND }, 'allow', fullAccess ? { fullAccess: true } : {});
  const after = await readFile(path, 'utf8');
  const line = f.sent[0]!.messages[0]!.content.split('\n').find(entry => entry.startsWith('- Shell tool:')) ?? '';
  return { result, appended: after === `${before}\n`, unchanged: after === before, line };
}

describe.skipIf(process.platform !== 'linux')('Astra 2192 R9: the open-shell note states the configuration file\'s approval rule truthfully', () => {
  it.skipIf(!bwrapReady)('an owner-approved call of a full-access turn appends to the configuration, and the prompt says an approved call can', async () => {
    const approved = await configWrite(false, true);
    expect({ card: approved.result.card, status: approved.result.status, appended: approved.appended }).toEqual({ card: true, status: 'ok', appended: true });
    expect(approved.result.text).toMatch(/^\[deckent\] run_shell: sandbox: bubblewrap; exit 0/u);
    expect(approved.line).not.toContain('its configuration file stay sealed: they are hidden or read-only, and a write to them fails');
    expect(approved.line).toContain(SEALED); expect(approved.line).toContain(CONFIG);
  }, 60_000);

  it.skipIf(!bwrapReady)('control: the same write the launched mode runs without a card fails read-only, under the same prompt line', async () => {
    const autonomous = await configWrite(true, true);
    expect({ card: autonomous.result.card, status: autonomous.result.status, unchanged: autonomous.unchanged }).toEqual({ card: false, status: 'error', unchanged: true });
    expect(autonomous.result.text).toContain('Read-only file system');
    expect(autonomous.line).toContain(SEALED); expect(autonomous.line).toContain(CONFIG);
  }, 60_000);

  it.skipIf(!bwrapReady)('closed view (standart): an owner-approved call also writes the configuration; the closed note makes no claim against it', async () => {
    const closed = await configWrite(false, false);
    expect({ card: closed.result.card, status: closed.result.status, appended: closed.appended }).toEqual({ card: true, status: 'ok', appended: true });
    expect(closed.line).toContain('in a closed bubblewrap sandbox: shell commands have no network access and your home directory is hidden; what a command may'
      + ' write is decided per call by policy and the permission mode.');
    expect(closed.line).not.toMatch(/configuration|write to them fails/u);
  }, 60_000);
});
