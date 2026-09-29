import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bubblewrapObservation, SHELL_CAPABILITIES_VERSION, type ShellCapabilities } from '#adapters/index.js';
import { shellSandboxCapabilities } from '#adapters/core/shell-sandbox-bwrap/index.js';

// BWRAP-SELECT: tests measure this host the way the service does (the selected bubblewrap launcher and its own sandbox run), but the
// bundled build is realized under a temporary state root of this test process, never under the owner's global state root.
let stateRoot: string | undefined;
export function measureTestShellHost(): Promise<ShellCapabilities> {
  if (!stateRoot) {
    const root = stateRoot = mkdtempSync(join(tmpdir(), 'deckent-test-state-'));
    process.once('exit', () => rmSync(root, { recursive: true, force: true }));
  }
  return shellSandboxCapabilities(stateRoot);
}
/** A synthetic Linux measurement (bubblewrap unavailable unless given) for tests that judge a provider against it. */
export const linuxShellHost = (overrides: Partial<ShellCapabilities> = {}): ShellCapabilities => ({ schemaVersion: SHELL_CAPABILITIES_VERSION, platform: 'linux',
  bubblewrap: bubblewrapObservation('unavailable'), userNamespace: 'available', landlock: { status: 'available', abi: 7 }, ...overrides });
