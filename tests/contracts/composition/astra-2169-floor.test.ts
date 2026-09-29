import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { landlockShellSandbox, type ShellSandboxFactory } from '#adapters/index.js';
import { closeModeRuntimes, modeRuntime, rule } from '../support/agent-turn-modes.js';
import { measureTestShellHost, linuxShellHost } from '../../fixtures/shell-host.js';
afterEach(closeModeRuntimes);
const capabilities = await measureTestShellHost();
console.log('CAPABILITIES', capabilities);
const abi = capabilities.landlock.status === 'available' ? capabilities.landlock.abi ?? 0 : 0;
const landlock: ShellSandboxFactory = layout => [{ kind: 'landlock', usable: () => landlockShellSandbox(layout).usable(linuxShellHost({ landlock: { status: 'available', abi } })) }];
for (const realm of ['bubblewrap', 'landlock'] as const) {
  it(`${realm}: an absent write-floor file must not be created without approval`, async () => {
    const f = await modeRuntime({ grants: [rule('shell-tool', 'agent-tool', ['run_shell'], 'require-approval', true), rule('shell-run', 'operation', ['host.shell.run'], 'allow')], mode: 'full-auto', shell: { schemaVersion: 1, realm: 'require-sandbox' }, ...(realm === 'landlock' ? { sandboxes: landlock } : {}) });
    const manifest = join(f.project, 'src/package.json');
    await expect(access(manifest)).rejects.toMatchObject({ code: 'ENOENT' });
    const result = await f.call('run_shell', { command: 'f=pack; echo ASTRA_NEW_FLOOR > src/${f}age.json' });
    const bytes = await readFile(manifest, 'utf8').catch(() => null);
    console.log('REPRO', { realm, result, bytes });
    expect(bytes).toBeNull();
  }, 60_000);
}
