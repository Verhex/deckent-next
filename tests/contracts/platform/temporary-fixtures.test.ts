import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareProductFile, resolveProductLayout } from '#platform/index.js';
import { canonicalTemporaryEnvironment } from '../../fixtures/canonical-temp.js';

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe.skipIf(process.platform === 'win32')('[requires POSIX symlink and managed-file custody] canonical temporary fixture custody', () => {
  it('uses the canonical OS temp parent in workers and descendants without changing product admission', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-temp-parent-')); roots.push(root);
    const alias = join(root, 'os-temp-alias'); await symlink(root, alias);
    const env = canonicalTemporaryEnvironment(alias);
    const child = await exec(process.execPath, ['--input-type=module', '-e',
      "import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'; console.log(mkdtempSync(join(tmpdir(), 'fixture-')));"],
    { env: { ...process.env, ...env } });
    const fixture = child.stdout.trim();
    expect(fixture.startsWith(root + '/fixture-')).toBe(true);
    expect(await realpath(fixture)).toBe(fixture);
    const layout = resolveProductLayout({ projectRoot: fixture });
    await expect(prepareProductFile(layout, 'ledger')).resolves.toBe(join(fixture, '.deckent/state/ledger.db'));
    const aliased = resolveProductLayout({ projectRoot: join(alias, fixture.slice(root.length + 1)) });
    await expect(prepareProductFile(aliased, 'ledger')).rejects.toThrow('MANAGED_FILE_UNSAFE');
  });

  it('still refuses a link introduced inside a canonical fixture root without writing through it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-temp-custody-')); roots.push(root);
    const outside = await mkdtemp(join(tmpdir(), 'deckent-temp-outside-')); roots.push(outside);
    await symlink(outside, join(root, '.deckent'));
    await expect(prepareProductFile(resolveProductLayout({ projectRoot: root }), 'ledger')).rejects.toThrow('MANAGED_FILE_UNSAFE');
    await expect(realpath(join(outside, 'state'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
