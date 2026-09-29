import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname } from 'node:path';

// Vitest globalSetup (main process): removes the run's temporary global state root that vitest.config.ts created and handed to every test
// worker as DECKENT_GLOBAL_HOME (bundled bubblewrap copies, secret-store files, the personal MCP registry, global config). Only a directory
// the config itself created (directly under the temp directory, with its prefix) is ever removed.
export default function setup(): () => void {
  const root = process.env['DECKENT_TEST_GLOBAL_HOME'];
  return () => {
    if (root && dirname(root) === tmpdir() && basename(root).startsWith('deckent-test-global-')) rmSync(root, { recursive: true, force: true });
  };
}
