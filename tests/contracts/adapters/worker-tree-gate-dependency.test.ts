import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scanWorkerTree, workerTreeViews } from '#adapters/index.js';
import { workerTreeExclusionSchema } from '#engine/index.js';
import { snapshotKnownSecrets } from '#platform/index.js';

// S6 dependency class (owner 2026-10-17): a read-only bind the task profile declares `dependencyTree` is third-party content. Pattern hits
// there are audited exceptions, evaluated once per tree identity; deny paths and configured values refuse it as everywhere. Risky inputs are
// built at run time so this file is not itself a credential carrier.
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(async root => { await chmod(root, 0o700).catch(() => undefined); await rm(root, { recursive: true, force: true }); })); });
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
/** Real archives a worker can extract whose stored bytes carry `text` as is: gzip with stored deflate blocks, and a one-entry stored (method 0) zip. */
const gzip = (text: string) => gzipSync(Buffer.from(text), { level: 0 });
function zip(name: string, text: string) {
  const data = Buffer.from(text), file = Buffer.from(name), header = (size: number) => Buffer.alloc(size);
  const local = header(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc32(data), 14);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(file.length, 26);
  const central = header(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc32(data), 16);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(file.length, 28);
  const end = header(22), offset = 30 + file.length + data.length; end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + file.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([local, file, data, central, file, end]);
}

describe('the dependency class', () => {
  it('accepts a 20 MB native binding and a third-party URL-userinfo fixture as audited exceptions, naming the binary by its digest', async () => {
    const binary = elf(), deps = await tree(dependencies(binary)), cache = await tree({});
    const scan = await scanWorkerTree(declared(deps), options(cache));
    const excluded = [{ path: `node_modules/${BINDING}`, rule: `native-binary:elf:sha256=${sha256(binary)}`, by },
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
  it('never allocates an oversized file whole: classification reads bounded windows, and a configured value across a window edge still refuses', async () => {
    const alloc = vi.spyOn(Buffer, 'alloc'), window = 1 << 20;
    expect(await scanWorkerTree(declared(await tree(dependencies())), options())).toMatchObject({ status: 'clean' });
    expect(await scanWorkerTree(declared(await tree({ ...dependencies(), [BINDING]: Buffer.alloc(BINARY_BYTES, 0x41) })), options())).toMatchObject({ status: 'incomplete', limit: 'file-bytes' });
    expect(alloc.mock.calls.filter(([size]) => typeof size === 'number' && size > window && size !== BINARY_BYTES).map(([size]) => size)).toEqual([]);
    // Only the fixtures themselves (built above in this test) are 20 MB; the gate's own reads stay within one window.
    expect(alloc.mock.calls.filter(([size]) => size === BINARY_BYTES)).toHaveLength(3);
    const known = snapshotKnownSecrets([{ name: 'ERP_PASSWORD', value: 'erp-hunter2-value' }]), straddling = elf(); straddling.write('erp-hunter2-value', window - 7);
    expect(await scanWorkerTree(declared(await tree(dependencies(straddling))), options(), known)).toMatchObject({ status: 'refused', findings: [{ path: `node_modules/${BINDING}`, rule: 'known-secret' }] });
  });
});

describe('parser parity for a native-claimed file in the class (polyglot: native header, text body)', () => {
  const edge = 1 << 20, value = 'erp-hunter2-value', known = snapshotKnownSecrets([{ name: 'ERP_PASSWORD', value }]);
  const { [BINDING]: _unused, ...text } = dependencies(); void _unused;
  const place = (bytes: Buffer, offset: number) => { const body = elf(); bytes.copy(body, offset); return body; };
  const utf32 = (text: string) => Buffer.concat([...text].map(char => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(char.codePointAt(0)!); return bytes; }));
  const escaped = Buffer.from([...value.slice(0, 3)].map(char => `\\u00${char.charCodeAt(0).toString(16)}`).join('') + value.slice(3));
  it('reads the body to its end: a configured value deep inside, across a window edge and in every reading a worker tool can take still refuses', async () => {
    for (const [name, bytes] of [['deep UTF-8', place(Buffer.from(value), 5 * edge + 123)], ['UTF-16LE at an odd offset across an edge', place(Buffer.from(value, 'utf16le'), 2 * edge - 9)],
      ['UTF-16LE with a BOM', place(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(value, 'utf16le')]), 7 * edge + 1)], ['UTF-32 across an edge', place(utf32(value), 3 * edge - 30)],
      ['a JSON escape split inside an escape', place(escaped, 4 * edge - 4)], ['a JSON escape split after one escape', place(escaped, 6 * edge - 6)]] as const) {
      expect(await scanWorkerTree(declared(await tree(dependencies(bytes))), options(), known), name).toMatchObject({ status: 'refused', findings: [{ path: `node_modules/${BINDING}`, rule: 'known-secret' }] });
    }
  });
  it('a NUL run of any length between the parts of a configured value or a refusing family, across a window edge, still refuses (Astra 2626 F2)', async () => {
    const gap = (head: Buffer, tail: Buffer, at: number, nuls: number) => { const body = elf(); head.copy(body, at); body.fill(0, at + head.length, at + head.length + nuls); tail.copy(body, at + head.length + nuls); return body; };
    const pem = ['-----BEGIN ', 'PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END ', 'PRIVATE KEY-----\n'].join('');
    for (const [name, bytes, rule] of [
      // Astra's layout: "erp" at W-100003, then 100000 NULs to the window edge, the rest at the start of the next window.
      ['the review layout', gap(Buffer.from('erp'), Buffer.from('-hunter2-value'), edge - 100_003, 100_000), 'known-secret'],
      ['a NUL run longer than a whole window', gap(Buffer.from('erp'), Buffer.from('-hunter2-value'), 2 * edge + 10, edge + (edge >> 1)), 'known-secret'],
      ['UTF-16LE split by a NUL run', gap(Buffer.from('erp', 'utf16le'), Buffer.from('-hunter2-value', 'utf16le'), 5 * edge - 70_006, 70_000), 'known-secret'],
      ['an escaped value split by a NUL run', gap(Buffer.from('\\u0065rp'), Buffer.from('-hunter2-value'), 7 * edge - 150_008, 150_000), 'known-secret'],
      ['a PEM header split by a NUL run', gap(Buffer.from(pem.slice(0, 15)), Buffer.from(pem.slice(15)), 9 * edge - 100_015, 100_000), 'pattern:private-key-block']] as const) {
      expect(await scanWorkerTree(declared(await tree(dependencies(bytes))), options(), known), name).toMatchObject({ status: 'refused', findings: [{ path: `node_modules/${BINDING}`, rule }] });
    }
    // A pending start the carry arithmetic cannot bound (a value prefix before megabytes of folded line breaks) is incomplete, never an unbounded carry.
    const lines = elf(); lines.write('erp', 3 * edge - 10, 'latin1'); lines.fill(0x0a, 3 * edge - 7, 3 * edge - 7 + ((5 * edge) >> 1));
    expect(await scanWorkerTree(declared(await tree(dependencies(lines))), options(), known)).toEqual({ status: 'incomplete', limit: 'file-bytes', observed: BINARY_BYTES, bound: DEFAULT_FILE_BYTES });
  });
  it('an archive appended to or embedded anywhere in an oversized native body is unclassifiable; chance signatures in machine code are not (Astra 2626 F1 follow-up)', async () => {
    const bound = { status: 'incomplete', limit: 'file-bytes', observed: BINARY_BYTES, bound: DEFAULT_FILE_BYTES };
    const pe = () => { const body = elf(); body.set([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0, 0xff, 0xff, 0, 0], 0); return body; };
    const into = (body: Buffer, bytes: Buffer, offset: number) => { bytes.copy(body, offset); return body; };
    const stored = zip('payload.json', '{"neutral":true}'), member = gzipSync(Buffer.from('neutral compressed payload '.repeat(40)));
    const xz = Buffer.from('fd377a585a000004e6d6b446', 'hex'), sevenZip = Buffer.from('377abcaf271c0004', 'hex');
    // A member whose stream breaks after some output (gunzip has already written it), and one hidden behind empty stored blocks past the probe.
    const broken = Buffer.from(member); broken.fill(0xff, broken.length - 40, broken.length - 8);
    const padded = Buffer.concat([Buffer.from('1f8b08000000000000ff', 'hex'), ...Array.from({ length: 14_000 }, () => Buffer.from('000000ffff', 'hex')), deflateRawSync(Buffer.from('neutral'))]);
    for (const [name, bytes] of [['ELF + a stored zip appended at the end', into(elf(), stored, BINARY_BYTES - stored.length)],
      ['PE + a stored zip appended at the end', into(pe(), stored, BINARY_BYTES - stored.length)], ['ELF + a gzip member mid-body', into(elf(), member, 7 * edge + 333)],
      ['PE + a gzip member across a window edge', into(pe(), member, 3 * edge - 5)], ['an xz stream header mid-body', into(elf(), xz, 11 * edge + 7)],
      ['a 7z signature mid-body', into(elf(), sevenZip, 13 * edge + 1)], ['a gzip member broken after output', into(elf(), broken, 9 * edge + 17)],
      ['a gzip member behind 70 KB of empty stored blocks', into(elf(), padded, 15 * edge + 3)]] as const) {
      expect(await scanWorkerTree(declared(await tree(dependencies(bytes))), options()), name).toEqual(bound);
    }
    // Byte rows copied from esbuild 0.25 and the rolldown binding (x86 immediates, Go's content-sniffing table): each format's own structure
    // rule rejects them, so these real bindings still classify.
    const chance = ['504b0304740c488b4c2450b801000000eb5b440fb742084d85c0740c488b4c2450b801000000eb45440fb7421a488b4c',
      '504b010248c78424000100002a00000048c78424080100002a0000004889b424f80000000f8550050000488d7206488d',
      '504b05060f84e100000031c0488d1d6d6e5d00b911000000488bbc2458010000488bb42460010000e8d035faff48899c',
      '526172211a0700000000000000000000ffff100009000000000000000f00000000000000080000000000000000000800',
      '526172211a07010000ca9a3b000000000065cd1d00000000400000000000000008000000000000002800000000000000',
      '1f8b080066c7407a000048837810006690740a0fb6507583ca048850754883784800740a0fb6507583ca088850754883'].map(row => Buffer.from(row, 'hex'));
    const machine = elf(); chance.forEach((row, index) => row.copy(machine, (5 + index) * edge + 64 * index));
    expect(await scanWorkerTree(declared(await tree(dependencies(machine))), options())).toMatchObject({ status: 'clean', excluded: [{ rule: `native-binary:elf:sha256=${sha256(machine)}` }, { path: `node_modules/${ZOD_TEST}` }] });
  });
  it('a deny-listed name refuses before any read; third-party pattern text in the body is listed as an exception', async () => {
    expect(await scanWorkerTree(declared(await tree({ ...dependencies(), 'pkg/.env': elf() })), options())).toMatchObject({ status: 'refused', findings: [{ path: 'node_modules/pkg/.env', rule: 'deny-path:**/.env' }] });
    const polyglot = place(Buffer.from(` ${USERINFO} `), 2 * edge + 3), scan = await scanWorkerTree(declared(await tree(dependencies(polyglot))), options());
    expect(scan).toEqual({ status: 'clean', excluded: [{ path: `node_modules/${BINDING}`, rule: `native-binary:elf:sha256=${sha256(polyglot)}`, by },
      { path: `node_modules/${BINDING}`, rule: 'pattern:url-userinfo', by }, { path: `node_modules/${ZOD_TEST}`, rule: 'pattern:url-userinfo', by }],
      dependencyTrees: [{ label: '/node_modules', reused: 0, evaluated: 3, saved: false }] });
  });
  it('a provider token or a PEM private key in a native-claimed file refuses — in an oversized body, across a window edge, or in a small binary; text fixtures stay exceptions', async () => {
    const token = ['sk', 'ant', 'api03', 'Zx9'.repeat(12)].join('-'), pem = ['-----BEGIN ', 'PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END ', 'PRIVATE KEY-----\n'].join('');
    for (const [name, files, rule] of [['token deep in the body', dependencies(place(Buffer.from(` ${token} `), 9 * edge + 77)), 'pattern:provider-token'],
      ['PEM block deep in the body', dependencies(place(Buffer.from(pem), 3 * edge + 11)), 'pattern:private-key-block'],
      ['token across a window edge', dependencies(place(Buffer.from(` ${token} `), 4 * edge - 20)), 'pattern:provider-token'],
      ['PEM header across a window edge', dependencies(place(Buffer.from(pem), 6 * edge - 13)), 'pattern:private-key-block'],
      ['PEM block in a small native file', { ...text, 'pkg/addon.node': place(Buffer.from(pem), 900).subarray(0, 4096) }, 'pattern:private-key-block']] as const) {
      expect(await scanWorkerTree(declared(await tree(files)), options()), name).toMatchObject({ status: 'refused', findings: [{ rule }] });
    }
    // The same shapes in ordinary text files of the tree (jose's import.js test key, a README token sample) stay audited exceptions.
    expect(await scanWorkerTree(declared(await tree({ ...text, 'jose/dist/import.js': `const key = \`${pem}\`;\n`, 'pkg/README.md': `export TOKEN=${token}\n` })), options()))
      .toMatchObject({ status: 'clean', excluded: expect.arrayContaining([{ path: 'node_modules/jose/dist/import.js', rule: 'pattern:private-key-block', by },
        { path: 'node_modules/pkg/README.md', rule: 'pattern:provider-token', by }]) });
  });
});

describe('only an owner-declared bind outside the workspace and the checkout takes the class', () => {
  const views = (workspace: string, source: string, checkoutRoot?: string) => ({ views: workerTreeViews(workspace, [{ source, target: '/node_modules', dependencyTree: { lockfile: '.package-lock.json' } }],
    { inputs: [], handoffInputs: [] }), options: { ...options(), ...(checkoutRoot ? { checkoutRoot } : {}) } });
  const { [BINDING]: _binary, ...text } = dependencies(); void _binary;
  it('a declared source inside the workspace, inside or around the work-target checkout, or reached through a symlink into either gets the normal rules', async () => {
    const workspace = await tree({ 'README.md': '# project\n', ...Object.fromEntries(Object.entries(text).map(([path, content]) => [`node_modules/${path}`, content])) });
    const normal = (scan: object, name: string) => { expect(scan, name).not.toHaveProperty('dependencyTrees'); expect(JSON.stringify(scan), name).not.toContain('dependencyTree:'); };
    const inside = views(workspace, join(workspace, 'node_modules')), insideScan = await scanWorkerTree(inside.views, inside.options);
    expect(insideScan).toMatchObject({ status: 'refused' }); normal(insideScan, 'inside the workspace');
    const checkout = await tree(Object.fromEntries(Object.entries(text).map(([path, content]) => [`node_modules/${path}`, content]))), clean = await tree({ 'README.md': '# x\n' });
    for (const source of [join(checkout, 'node_modules'), checkout]) {
      const shared = views(clean, source, join(checkout, source === checkout ? 'node_modules' : ''));
      const scan = await scanWorkerTree(shared.views, shared.options); expect(scan, source).toMatchObject({ status: 'refused' }); normal(scan, source);
    }
    const links = await tree({}); await symlink(join(checkout, 'node_modules'), join(links, 'deps'));
    const linked = views(clean, join(links, 'deps'), checkout);
    // (Production refuses a linked bind source outright: resolveDockerReadOnlyMounts.) Here the link escapes into the checkout: no class.
    normal(await scanWorkerTree(linked.views, linked.options), 'symlink into the checkout');
    // The same bind outside both takes the class.
    const outside = views(clean, await tree(text), checkout);
    expect(await scanWorkerTree(outside.views, outside.options)).toMatchObject({ status: 'clean', excluded: [{ rule: 'pattern:url-userinfo', by }] });
  });
  it('nothing a repository, worker or task input controls grants it: in-repo markers, inputs, handoff files and prompt text keep the normal rules', async () => {
    const workspace = await tree({ ...text, 'package.json': '{"name":"x","dependencyTree":{"lockfile":".package-lock.json"}}\n', 'dependencyTree': 'lockfile=.package-lock.json\n' });
    const scan = await scanWorkerTree(workerTreeViews(workspace, undefined, { inputs: [{ name: 'deps', path: await tree(text) }],
      handoffInputs: [{ target: '/deckent/inputs/_shared.json', path: join(await tree({ 'h.json': `{"u":"${USERINFO}"}` }), 'h.json') }], dependencyContext: { text: USERINFO } }), options(await tree({})));
    expect(scan).toMatchObject({ status: 'refused', count: 4 });
    expect(scan).not.toHaveProperty('dependencyTrees'); expect(JSON.stringify(scan)).not.toContain('dependencyTree:');
  });
  it('a deny-listed file at any depth of the class refuses: .env, a key, cloud credentials; archives stay unscannable unless an operator glob lifts them', async () => {
    for (const [path, content, rule] of [['pkg/test/fixtures/.env', 'API_KEY=fixture\n', 'deny-path:**/.env'], ['a/b/c/server.key', 'k\n', 'deny-path:**/*.key'],
      ['pkg/.aws/credentials', '[default]\n', 'deny-path:**/.aws']] as const) {
      expect(await scanWorkerTree(declared(await tree({ ...text, [path]: content })), options()), path).toMatchObject({ status: 'refused', findings: [{ path: expect.stringContaining('node_modules/'), rule }] });
    }
    const archive = { ...text, 'pkg/fixture.tgz': Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0]) };
    expect(await scanWorkerTree(declared(await tree(archive)), options())).toMatchObject({ status: 'refused', findings: [{ path: 'node_modules/pkg/fixture.tgz', rule: 'unscannable:archive-gzip' }] });
  });
  it('an archive is a finding whatever its readable bytes match: a real gzip or zip carrying a pattern is refused, liftable only by an operator glob (Astra 2626 F1)', async () => {
    const archives = { 'pkg/fixture.json.gz': gzip(`{"url":"${USERINFO}"}`), 'pkg/fixture.zip': zip('fixture.json', `{"url":"${USERINFO}"}`) };
    for (const [path, bytes] of Object.entries(archives)) expect(bytes.includes(USERINFO), path).toBe(true);
    expect(await scanWorkerTree(declared(await tree({ ...text, ...archives })), options())).toEqual({ status: 'refused', count: 2, findings: [
      { path: 'node_modules/pkg/fixture.json.gz', rule: 'unscannable:archive-gzip' }, { path: 'node_modules/pkg/fixture.zip', rule: 'unscannable:archive-zip' }],
    excluded: [{ path: `node_modules/${ZOD_TEST}`, rule: 'pattern:url-userinfo', by }], dependencyTrees: [{ label: '/node_modules', reused: 0, evaluated: 3, saved: false }] });
    const glob = { ...options(), allowPatternPaths: ['node_modules/pkg/fixture.*'] };
    expect(await scanWorkerTree(declared(await tree({ ...text, ...archives })), glob)).toMatchObject({ status: 'clean', excluded: expect.arrayContaining([
      { path: 'node_modules/pkg/fixture.json.gz', rule: 'unscannable:archive-gzip', by: 'allowPatternPaths:node_modules/pkg/fixture.*' },
      { path: 'node_modules/pkg/fixture.zip', rule: 'unscannable:archive-zip', by: 'allowPatternPaths:node_modules/pkg/fixture.*' }]) });
    // Above the text bound a native header that is also an archive (a tar whose first member name is the ELF magic) is never classified.
    const tar = elf(); tar.write('ustar', 257, 'latin1');
    expect(await scanWorkerTree(declared(await tree(dependencies(tar))), options())).toEqual({ status: 'incomplete', limit: 'file-bytes', observed: BINARY_BYTES, bound: DEFAULT_FILE_BYTES });
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
    // A tree changed after caching is evaluated again: a configured value written into a cached file refuses at once.
    await writeFile(join(deps, 'zod/package.json'), '{"name":"zod","password":"erp-hunter2-value"}\n');
    expect(await scanWorkerTree(declared(deps), options(cache), snapshotKnownSecrets([{ name: 'ERP_PASSWORD', value: 'erp-hunter2-value' }])))
      .toMatchObject({ status: 'refused', findings: [{ path: 'node_modules/zod/package.json', rule: 'known-secret' }] });
    await writeFile(join(deps, 'zod/package.json'), '{"name":"zod"}\n');
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
    // A forged entry with the right scope, path and content digest saying "pattern" cannot turn an archive into an exception (Astra 2626 F1).
    await rm(join(deps, 'zod/.npmrc')); await writeFile(join(deps, 'zod/data.gz'), gzip('{"neutral":true}'));
    expect(await scanWorkerTree(declared(deps), options(cache))).toMatchObject({ status: 'refused', count: 1, findings: [{ path: 'node_modules/zod/data.gz', rule: 'unscannable:archive-gzip' }] });
    const saved = JSON.parse(await readFile(join(cache, file!), 'utf8')) as { files: Record<string, [string, string | null]> };
    saved.files['node_modules/zod/data.gz'] = [sha256(gzip('{"neutral":true}')), 'url-userinfo']; await writeFile(join(cache, file!), JSON.stringify(saved));
    expect(await scanWorkerTree(declared(deps), options(cache))).toMatchObject({ status: 'refused', count: 1, findings: [{ path: 'node_modules/zod/data.gz', rule: 'unscannable:archive-gzip' }] });
    await rm(join(deps, 'zod/data.gz'));
    // Without a cache directory, or with one that cannot be written, the scan is complete and the same; the save is reported as failed.
    const unwritable = await tree({}); await chmod(unwritable, 0o500);
    for (const directory of [undefined, join(unwritable, 'cache')]) {
      expect(await scanWorkerTree(declared(deps), options(directory))).toEqual({ ...first, dependencyTrees: [{ label: '/node_modules', reused: 0, evaluated: 3, saved: false }] });
    }
  });
});
