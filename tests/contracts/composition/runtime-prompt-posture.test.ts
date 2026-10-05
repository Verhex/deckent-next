import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_TURN_SYSTEM_PROMPT_VERSION } from '#engine/index.js';
import { landlockShellSandbox, type ShellSandboxFactory } from '#adapters/index.js';
import { closeModeRuntimes, modeRuntime, rule, type Mode } from '../support/agent-turn-modes.js';
import { linuxShellHost, measureTestShellHost } from '../../fixtures/shell-host.js';

// PROMPT-POSTURE (live 2026-09-30, LIVE-SWITCH-BATCH14 full-access-workline-3: a full-access model refused `curl -sI https://registry.npmjs.org/`
// "by policy" because the v5 prompt said "Network access: none … do not try to reach the network another way" whenever fetch_url was not
// configured). Prompt v6 states the shell's posture for the turn from the realm the turn's shell calls resolve (the same resolution and
// open-view rule as each call), separately from fetch_url. Real runtime service, real policy files; the posture is read from the system
// message the model endpoint actually received. No shell command runs here (the scripted call is a read), so a synthetic Landlock
// measurement is enough for the Landlock cases.
afterEach(closeModeRuntimes);
const measured = await measureTestShellHost();
const bwrapReady = measured.bubblewrap.status === 'available';
const landlockOnly: ShellSandboxFactory = layout => [{ kind: 'landlock', usable: () => landlockShellSandbox(layout).usable(linuxShellHost({ landlock: { status: 'available', abi: 6 } })) }];
const FULL_ACCESS = rule('full-access', 'permission-mode', ['full-access'], 'allow', false, ['set']);
const GRANTS = [rule('read', 'agent-tool', ['read_file', 'list_dir', 'glob', 'grep'], 'allow'), rule('shell-tool', 'agent-tool', ['run_shell'], 'require-approval', true),
  rule('shell-run', 'operation', ['host.shell.run'], 'allow'), FULL_ACCESS];
const NO_NETWORK = '- Network access: none. This installation allows no fetching: do not guess what a web page says, and do not try to reach the network another way.';

async function systemPrompt(input: { readonly realm: 'require-sandbox' | 'prefer-sandbox' | 'host'; readonly fullAccess: boolean; readonly sandboxes?: ShellSandboxFactory;
  readonly mode?: Mode | null }): Promise<string> {
  const f = await modeRuntime({ grants: GRANTS, mode: input.mode ?? null, dataRoot: '.deckent/data', shell: { schemaVersion: 1, realm: input.realm },
    ...(input.sandboxes ? { sandboxes: input.sandboxes } : {}) });
  const turn = await f.call('read_file', { path: 'src/a.ts' }, 'deny', input.fullAccess ? { fullAccess: true } : {});
  expect(turn.status).toBe('ok');
  const system = f.sent[0]!.messages[0]!;
  expect(system.role).toBe('system');
  expect(system.content.startsWith(`[Deckent runtime instructions v${AGENT_TURN_SYSTEM_PROMPT_VERSION}]`)).toBe(true);
  return system.content;
}
const shellLine = (prompt: string) => prompt.split('\n').find(line => line.startsWith('- Shell tool: run_shell.')) ?? '';

describe.skipIf(process.platform !== 'linux')('the shell posture in the system prompt comes from the turn\'s realm (prompt v6)', () => {
  it.skipIf(!bwrapReady)('full access in bubblewrap: the open view — network, the real HOME, project and .git writable, Deckent state sealed; no "no network" line', async () => {
    const prompt = await systemPrompt({ realm: 'require-sandbox', fullAccess: true });
    // The live finding first: the v5 text told a full-access model there was no network.
    expect(prompt).not.toContain('Network access: none'); expect(prompt).not.toContain('do not try to reach the network');
    expect(shellLine(prompt)).toContain('in an open bubblewrap sandbox (full access): shell commands have network access');
    expect(shellLine(prompt)).toMatch(/your real home directory \(HOME\) is visible and writable, and the project and its \.git are writable/u);
    expect(shellLine(prompt)).toMatch(/Deckent's own state, policy and credential files stay sealed[^\n]*Its configuration file is read-only unless the owner approves the call/u);
    expect(prompt).toContain('- Network: fetch_url is not offered (this installation configures no fetching); shell commands do have network access in this turn');
  }, 60_000);

  it.skipIf(!bwrapReady)('standart in bubblewrap: the closed view — no network, HOME hidden; the v5 no-network line stays', async () => {
    const prompt = await systemPrompt({ realm: 'require-sandbox', fullAccess: false });
    expect(shellLine(prompt)).toContain('in a closed bubblewrap sandbox: shell commands have no network access and your home directory is hidden');
    expect(prompt).toContain(NO_NETWORK); expect(prompt).not.toContain('have network access');
  }, 60_000);

  it('full access where only Landlock is usable: require-sandbox keeps the closed Landlock view (no network); prefer-sandbox runs on the host (network)', async () => {
    const closed = await systemPrompt({ realm: 'require-sandbox', fullAccess: true, sandboxes: landlockOnly });
    expect(shellLine(closed)).toContain('in a closed landlock sandbox: shell commands have no network access');
    expect(closed).toContain(NO_NETWORK); expect(closed).not.toContain('open bubblewrap');
    const host = await systemPrompt({ realm: 'prefer-sandbox', fullAccess: true, sandboxes: landlockOnly });
    expect(host).not.toContain('Network access: none');
    expect(shellLine(host)).toContain('directly on the user\'s machine, not in a sandbox: files, processes and the network are reachable');
    expect(host).not.toContain('Network access: none'); expect(host).not.toContain('do not try to reach the network');
  }, 60_000);

  it('a closed Landlock turn says no network; the explicit host realm says the network is reachable; a required sandbox with none usable refuses every call', async () => {
    const closed = await systemPrompt({ realm: 'prefer-sandbox', fullAccess: false, sandboxes: landlockOnly });
    expect(shellLine(closed)).toContain('in a closed landlock sandbox'); expect(closed).toContain(NO_NETWORK);
    const host = await systemPrompt({ realm: 'host', fullAccess: false });
    expect(shellLine(host)).toContain('not in a sandbox'); expect(host).not.toContain('Network access: none');
    const none = await systemPrompt({ realm: 'require-sandbox', fullAccess: true, sandboxes: () => [] });
    expect(shellLine(none)).toContain('It cannot run commands here'); expect(none).toContain(NO_NETWORK);
  }, 60_000);
});
