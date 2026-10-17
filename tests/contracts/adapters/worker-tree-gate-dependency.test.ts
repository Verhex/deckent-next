import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanWorkerTree, workerTreeViews } from '#adapters/index.js';
import { workerTreeExclusionSchema } from '#engine/index.js';
import { snapshotKnownSecrets } from '#platform/index.js';

// S6 dependency class (owner 2026-10-17): a read-only bind the task profile declares `dependencyTree` is third-party content. Pattern hits
// there are audited exceptions, evaluated once per tree identity; deny paths and configured values refuse it as everywhere. Risky inputs are
// built at run time so this file is not itself a credential carrier.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(async root => { await chmod(root, 0o700).catch(() => undefined); await rm(root, { recursive: true, force: true }); })); });
/** The shipped `execution.secretGate.maxFileBytes` default: the rolldown binding (19.3 MB) was refused against it (DOGFOOD-50 pilot2). */
const DEFAULT_FILE_BYTES = 16_777_216, BINARY_BYTES = 20 * 1024 * 1024;
const options = (cacheDirectory?: string) => ({ allowPatternPaths: [] as string[], acknowledgedDenyPaths: [] as string[], maxFiles: 1000, maxFileBytes: DEFAULT_FILE_BYTES,
  maxTotalBytes: 1 << 28, timeoutMs: 60_000, ...(cacheDirectory ? { cacheDirectory } : {}) });
const USERINFO = ['https://', 'fixture-user', ':', 'fixture-pass', '@example.invalid/path'].join('');
const NPM_TOKEN = ['npm', 'Ab3'.repeat(12)].join('_');
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
/** A native binding: the ELF signature, its NUL-bearing header and a body above the text scan bound. */
function elf(size = BINARY_BYTES) { const bytes = Buffer.alloc(size, 0x41); bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0]); return bytes; }
async function tree(files: Record<string, string | Buffer>) {
  const root = await mkdtemp(join(tmpdir(), 'dn-dependency-gate-')); roots.push(root);
  for (const [path, content] of Object.entries(files)) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), content); }
  return root;
}
const BINDING = '@rolldown/binding-linux-x64-gnu/rolldown-binding.linux-x64-gnu.node', ZOD_TEST = 'zod/src/v4/classic/tests/string.test.ts';
const dependencies = (binary = elf()) => ({ '.package-lock.json': '{"lockfileVersion":3}\n', [BINDING]: binary,
  [ZOD_TEST]: `expect(z.url().parse("${USERINFO}")).toBeTruthy();\n`, 'zod/package.json': '{"name":"zod"}\n' });
const declared = (source: string, dependencyTree: { lockfile: string } | null = { lockfile: '.package-lock.json' }) =>
  workerTreeViews('/nonexistent-checkout', [{ source, target: '/node_modules', ...(dependencyTree ? { dependencyTree } : {}) }], { inputs: [], handoffInputs: [] }).slice(1);
const by = 'dependencyTree:/node_modules';

describe('the dependency class', () => {
  it('accepts a 20 MB native binding and a third-party URL-userinfo fixture as audited exceptions, naming the binary by its digest', async () => {
    const binary = elf(), deps = await tree(dependencies(binary)), cache = await tree({});
    const scan = await scanWorkerTree(declared(deps), options(cache));
    const excluded = [{ path: `node_modules/${BINDING}`, rule: `unscanned-binary:elf:sha256=${sha256(binary)}`, by },
      { path: `node_modules/${ZOD_TEST}`, rule: 'pattern:url-userinfo', by }];
    expect(scan).toEqual({ status: 'clean', excluded, dependencyTrees: [{ label: '/node_modules', reused: 0, evaluated: 3, saved: true }] });
    // The exceptions are the audited, journalled form the Run card shows (path, rule, lifting entry; never a value).
    for (const entry of excluded) expect(workerTreeExclusionSchema.parse(entry)).toEqual(entry);
    expect(JSON.stringify(scan)).not.toContain('fixture-pass');
  });
  it('is the declared bind only: the same content in the checkout or in an undeclared bind is still refused or unscannable', async () => {
    const binary = elf(), scanBound = { status: 'incomplete', limit: 'file-bytes', observed: BINARY_BYTES, bound: DEFAULT_FILE_BYTES };
    expect(await scanWorkerTree(await tree(dependencies(binary)), options())).toEqual(scanBound);
    expect(await scanWorkerTree(declared(await tree(dependencies(binary)), null), options())).toEqual(scanBound);
    const { [BINDING]: _binary, ...text } = dependencies(binary); void _binary;
    expect(await scanWorkerTree(await tree(text), options())).toEqual({ status: 'refused', count: 1, findings: [{ path: ZOD_TEST, rule: 'pattern:url-userinfo' }] });
    expect(await scanWorkerTree(declared(await tree(text), null), options())).toEqual({ status: 'refused', count: 1,
      findings: [{ path: `node_modules/${ZOD_TEST}`, rule: 'pattern:url-userinfo' }] });
    // The prompt and argv views and task inputs never take the class either: the view list carries it only for a declared profile bind.
    const views = workerTreeViews('/w', [{ source: '/d', target: '/deps', dependencyTree: { lockfile: 'l' } }, { source: '/e', target: '/plain' }],
      { inputs: [{ name: 'brief', path: '/i' }], handoffInputs: [{ target: '/deckent/inputs/_shared.json', path: '/h' }], dependencyContext: { text: 'context' } }, ['run']);
    expect(views.filter(view => 'dependencyTree' in view)).toEqual([{ source: '/d', label: '/deps', dependencyTree: { lockfile: 'l' } }]);
  });
  it('still refuses a deny path (an .npmrc with a token), a configured secret value — in text or inside the binary — and a deny-path symlink', async () => {
    const known = snapshotKnownSecrets([{ name: 'ERP_PASSWORD', value: 'erp-hunter2-value' }]);
    const withKnown = elf(); withKnown.write('erp-hunter2-value', 4096);
    const deps = await tree({ ...dependencies(withKnown), 'left-pad/.npmrc': `//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n`,
      'erp-client/lib/config.js': 'connect("erp-hunter2-value")\n' });
    await symlink('../../home/.ssh/id_rsa', join(deps, 'zod/key'));
    const scan = await scanWorkerTree(declared(deps), options(await tree({})), known);
    expect(scan).toMatchObject({ status: 'refused', count: 4, findings: [{ path: `node_modules/${BINDING}`, rule: 'known-secret' },
      { path: 'node_modules/erp-client/lib/config.js', rule: 'known-secret' }, { path: 'node_modules/left-pad/.npmrc', rule: 'deny-path:**/.npmrc' },
      { path: 'node_modules/zod/key', rule: 'deny-path:**/id_rsa*' }] });
    expect(JSON.stringify(scan)).not.toContain(NPM_TOKEN); expect(JSON.stringify(scan)).not.toContain('hunter2');
  });
  it('fails closed on a file above the bound it cannot classify: large text, or a binary signature without a NUL-bearing header', async () => {
    const bound = { status: 'incomplete', limit: 'file-bytes', observed: BINARY_BYTES, bound: DEFAULT_FILE_BYTES };
    expect(await scanWorkerTree(declared(await tree({ ...dependencies(), [BINDING]: 'x'.repeat(BINARY_BYTES) })), options())).toEqual(bound);
    const noNul = Buffer.alloc(BINARY_BYTES, 0x41); noNul.write('\x7fELF', 0, 'latin1');
    expect(await scanWorkerTree(declared(await tree({ ...dependencies(), [BINDING]: noNul })), options())).toEqual(bound);
    // The other bounds still hold for the class: total bytes and file count.
    expect(await scanWorkerTree(declared(await tree(dependencies())), { ...options(), maxTotalBytes: DEFAULT_FILE_BYTES })).toMatchObject({ status: 'incomplete', limit: 'total-bytes' });
    expect(await scanWorkerTree(declared(await tree(dependencies())), { ...options(), maxFiles: 2 })).toMatchObject({ status: 'incomplete', limit: 'files' });
  });
});

describe('the pattern cache of a declared dependency tree', () => {
  it('reuses each file result on the next dispatch, evaluates a changed file again and starts over when the lockfile changes', async () => {
    const deps = await tree({ ...dependencies(), 'a/index.js': 'module.exports = 1;\n' }), cache = await tree({});
    const first = await scanWorkerTree(declared(deps), options(cache));
    expect(first).toMatchObject({ status: 'clean', dependencyTrees: [{ reused: 0, evaluated: 4, saved: true }] });
    expect(await readdir(cache)).toHaveLength(1);
    const second = await scanWorkerTree(declared(deps), options(cache));
    // Same decision and the same audited exceptions; only the pattern evaluations dropped (4 → 0).
    expect(second).toEqual({ ...first, dependencyTrees: [{ label: '/node_modules', reused: 4, evaluated: 0, saved: true }] });
    await writeFile(join(deps, 'a/index.js'), `module.exports = "${USERINFO}";\n`);
    const changed = await scanWorkerTree(declared(deps), options(cache));
    expect(changed).toMatchObject({ dependencyTrees: [{ reused: 3, evaluated: 1 }] });
    expect((changed as { excluded: { path: string }[] }).excluded.map(entry => entry.path)).toContain('node_modules/a/index.js');
    await writeFile(join(deps, '.package-lock.json'), '{"lockfileVersion":3,"packages":{}}\n');
    expect(await scanWorkerTree(declared(deps), options(cache))).toMatchObject({ dependencyTrees: [{ reused: 0, evaluated: 4 }] });
  });
  it('never decides: a corrupt, forged or unwritable cache changes reuse only, and a refusal still refuses', async () => {
    const deps = await tree(dependencies()), cache = await tree({});
    const first = await scanWorkerTree(declared(deps), options(cache)), [file] = await readdir(cache);
    await writeFile(join(cache, file!), '{not json');
    expect(await scanWorkerTree(declared(deps), options(cache))).toEqual(first);
    // A forged entry (another scope's shape, every file "clean") cannot pass a deny path or a configured value.
    const stored = JSON.parse(await readFile(join(cache, file!), 'utf8')) as { files: Record<string, [string, string | null]> };
    for (const entry of Object.values(stored.files)) entry[1] = null;
    await writeFile(join(cache, file!), JSON.stringify(stored));
    await writeFile(join(deps, 'zod/.npmrc'), `//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n`);
    expect(await scanWorkerTree(declared(deps), options(cache))).toMatchObject({ status: 'refused', findings: [{ path: 'node_modules/zod/.npmrc', rule: 'deny-path:**/.npmrc' }] });
    // Without a cache directory, or with one that cannot be written, the scan is complete and the same; the save is reported as failed.
    await rm(join(deps, 'zod/.npmrc'));
    const unwritable = await tree({}); await chmod(unwritable, 0o500);
    for (const directory of [undefined, join(unwritable, 'cache')]) {
      expect(await scanWorkerTree(declared(deps), options(directory))).toEqual({ ...first, dependencyTrees: [{ label: '/node_modules', reused: 0, evaluated: 3, saved: false }] });
    }
  });
});
