// A real argument-count refusal taken from the isolated launcher's own argument builder (no file system access, nothing launched): the
// stored text a closed headless preflight record keeps, in the language asked for.
import { isolatedProcessCommand } from '#adapters/core/shell-sandbox-bwrap/index.js';

export function producedSandboxRefusal(language: 'en' | 'tr', directoryMasks = 1_500, hiddenPackage = false): string {
  // A pinned launcher package hidden at its own path (outside every system mount): one hidden path, its tmpfs and remount, and the pin.
  const pinned = hiddenPackage ? { pinnedExecutable: { fd: 3, target: '/tmp/fixture-package/cli', hideDirectory: '/tmp/fixture-package' } } : {};
  const view = { workDir: '/tmp/work', workFiles: [], executables: [], stateDir: '/tmp/state', sockets: [], tmpfsBytes: 1_048_576, ...pinned,
    stateMasks: { directories: Array<string>(directoryMasks).fill('/tmp/state/masked'), files: [] } };
  try {
    isolatedProcessCommand({ shell: '/bin/sh', launcher: '/bin/bwrap', view, fileSizeBlocks: 1024, openFiles: 32, command: ['/bin/true'],
      environment: { DECKENT_LANGUAGE: language } });
  } catch (error) { return (error as Error).message; }
  throw new Error('the isolated launcher accepted the fixture view');
}
/** The record the earlier tests used: its sum and catalog text hold, but its "other setup 4" is below what every isolated view carries. */
export const UNPRODUCIBLE_SANDBOX_REFUSAL = 'The launcher needs 9007 arguments and can accept at most 9000. Argument counts: HOME masks 0, project/state and host protection 8994, ancestor pins 0, final read-only remounts 2, command tail 7, other setup 4. Use a dedicated CLI configuration directory with fewer entries, then reconnect and retry';
