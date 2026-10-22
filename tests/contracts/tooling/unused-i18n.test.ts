import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// scripts/audit-unused-i18n.mjs proves the retired i18n namespaces stay retired. It scans every .ts file, this one included, so the
// retired prefix text is assembled at runtime from the script's own `prefixes` line and never written here literally.
const script = fileURLToPath(new URL('../../../scripts/audit-unused-i18n.mjs', import.meta.url));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
interface Audit { keys: string[]; keyCount: number; typescriptFiles: number; references: string[] }
// A regular-file receipt avoids pipe-capture EPERM in restricted hosts; the exit status stays the child's own.
function audit(path: string): { status: number | null; report: Audit } {
  const receipt = join(tmpdir(), `deckent-unused-i18n-${process.pid}-${roots.length}.json`), fd = openSync(receipt, 'w');
  try {
    const result = spawnSync(process.execPath, [path], { stdio: ['ignore', fd, 'ignore'], timeout: 60_000 });
    if (result.error) throw result.error;
    return { status: result.status, report: JSON.parse(readFileSync(receipt, 'utf8')) as Audit };
  } finally { closeSync(fd); void rm(receipt, { force: true }); }
}

describe('retired i18n namespace audit', () => {
  it('finds no retired key and no reference in the repository', () => {
    const { status, report } = audit(script);
    expect(status).toBe(0);
    expect(report).toMatchObject({ keys: [], keyCount: 0, references: [] });
    expect(report.typescriptFiles).toBeGreaterThan(0);
  });
  it('fails with exactly one reference when a .ts file names a retired namespace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-unused-i18n-')); roots.push(root);
    const prefix = /const prefixes = \['([^']+)'/u.exec(readFileSync(script, 'utf8'))?.[1];
    expect(prefix).toBeDefined();
    await mkdir(join(root, 'scripts'));
    await cp(script, join(root, 'scripts/audit-unused-i18n.mjs'));
    for (const locale of ['en', 'tr']) {
      await mkdir(join(root, `src/platform/core/i18n/locales/${locale}`), { recursive: true });
      await writeFile(join(root, `src/platform/core/i18n/locales/${locale}/cli.json`), '{}');
    }
    await writeFile(join(root, 'src/uses.ts'), `export const key = '${prefix!}name';\n`);
    const { status, report } = audit(join(root, 'scripts/audit-unused-i18n.mjs'));
    expect(status).toBe(1);
    expect(report.references).toHaveLength(1);
    expect(report.references[0]).toContain('src/uses.ts:1');
  });
});
