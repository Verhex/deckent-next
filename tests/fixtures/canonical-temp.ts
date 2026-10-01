import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Only the test harness's OS temporary directory is resolved. Product roots and explicit
// DECKENT_TEST_GLOBAL_HOME remain subject to the product's ordinary custody checks.
// os.tmpdir() may contain an OS symlink (macOS /var); fixture roots must be canonical.
export function canonicalTemporaryEnvironment(directory = tmpdir()): Record<'TMPDIR' | 'TMP' | 'TEMP', string> {
  const root = realpathSync(directory);
  return { TMPDIR: root, TMP: root, TEMP: root };
}
