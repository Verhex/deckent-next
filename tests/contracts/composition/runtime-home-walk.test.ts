import { writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeModeRuntimes, modeRuntime, rule } from '../support/agent-turn-modes.js';
import { measureTestShellHost } from '../../fixtures/shell-host.js';

const measured = await measureTestShellHost();
if (measured.bubblewrap.status !== 'available') console.info('verify-not-run: HOME approval/runtime execution', JSON.stringify(measured));
afterEach(async () => { vi.unstubAllEnvs(); await closeModeRuntimes(); });
// Batch F: the shell rule is not mode-eligible, so full access still shows the approval card and the command runs only after it is approved.
const grants = [rule('shell-tool', 'agent-tool', ['run_shell'], 'require-approval'), rule('shell-run', 'operation', ['host.shell.run'], 'allow'),
  rule('full-access', 'permission-mode', ['full-access'], 'allow', false, ['set'])];

describe.skipIf(measured.bubblewrap.status !== 'available')('HOME protection through the real approval/runtime surface', () => {
  it('approves the credential command unchanged, then proves large-HOME execution and credential isolation', async () => {
    const f = await modeRuntime({ grants, mode: 'full-auto', shell: { schemaVersion: 1, realm: 'require-sandbox' } });
    const home = f.env.HOME; vi.stubEnv('HOME', home);
    const secret = 'SYNTHETIC-APPROVED-HOME-SECRET'; await writeFile(join(home, '.npmrc'), secret);
    for (let repo = 0; repo < 5; repo++) {
      const tree = join(home, 'worktrees', `repo-${repo}`); await mkdir(tree, { recursive: true });
      for (let file = 0; file < 10_020; file++) writeFileSync(join(tree, `${file}.txt`), 'ordinary');
      await writeFile(join(tree, 'private.pem'), secret);
    }
    const command = 'cat "$HOME/.npmrc"; for key in "$HOME"/worktrees/repo-*/private.pem; do cat "$key"; done; printf changed >> "$HOME/.npmrc"; echo executed > marker';
    const out = await f.call('run_shell', { command }, 'allow', { fullAccess: true });
    expect(out.card).toBe(true); expect(out.status, out.text).toBe('ok'); expect(out.text).toContain('sandbox: bubblewrap; exit 0');
    expect(out.text).not.toContain(secret); expect(await readFile(join(home, '.npmrc'), 'utf8')).toBe(secret);
    expect(await readFile(join(f.project, 'marker'), 'utf8')).toBe('executed\n');
  });

  it('with a mode-eligible rule, full access runs the same command without a card and still hides HOME credentials', async () => {
    const eligible = [rule('shell-tool', 'agent-tool', ['run_shell'], 'require-approval', true), ...grants.slice(1)];
    const f = await modeRuntime({ grants: eligible, mode: 'full-auto', shell: { schemaVersion: 1, realm: 'require-sandbox' } });
    const home = f.env.HOME; vi.stubEnv('HOME', home);
    const secret = 'SYNTHETIC-FULL-ACCESS-HOME-SECRET'; await writeFile(join(home, '.npmrc'), secret);
    const out = await f.call('run_shell', { command: 'cat "$HOME/.npmrc"; printf changed >> "$HOME/.npmrc"; echo executed > marker' }, 'allow', { fullAccess: true });
    expect(out.card).toBe(false); expect(out.status, out.text).toBe('ok'); expect(out.text).toContain('sandbox: bubblewrap');
    expect(out.text).not.toContain(secret); expect(await readFile(join(home, '.npmrc'), 'utf8')).toBe(secret);
    expect(await readFile(join(f.project, 'marker'), 'utf8')).toBe('executed\n');
  });

  it('approves the same command but refuses before execution when HOME cannot be determined', async () => {
    const f = await modeRuntime({ grants, mode: 'full-auto', shell: { schemaVersion: 1, realm: 'require-sandbox' } });
    const fake = join(f.env.HOME, 'not-a-directory'); await writeFile(fake, 'ordinary'); vi.stubEnv('HOME', fake);
    const out = await f.call('run_shell', { command: 'cat "$HOME/.npmrc"; echo unsafe > marker' }, 'allow', { fullAccess: true });
    expect(out.card).toBe(true); expect(out.status).toBe('error'); expect(out.text).toContain('SHELL_HOME_CREDENTIALS_UNDETERMINED');
    await expect(readFile(join(f.project, 'marker'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
