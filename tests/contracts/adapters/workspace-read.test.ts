import { chmod, link, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createGlobMatcher, createWorkspaceReadTools, createWorkspaceScope, MAX_WALK_DEPTH, openWalkedFile, walkWorkspaceFiles, WORKSPACE_READ_TOOL_SPECS } from '#adapters/index.js';
import { agentToolSpecSchema } from '#domain/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(async root => { execFileSync('chmod', ['-R', 'u+rwx', root]); await rm(root, { recursive: true, force: true }); })); });

async function workspace(files: Record<string, string | Buffer>) {
  const base = await mkdtemp(join(tmpdir(), 'dn-workspace-read-')); roots.push(base);
  const root = join(base, 'ws'); await mkdir(root);
  for (const [path, content] of Object.entries(files)) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), content); }
  return { base, root };
}
const meta = (text: string) => text.split('\n')[0]!;

it('declares valid read-class tool specs', () => {
  expect(WORKSPACE_READ_TOOL_SPECS.map(spec => agentToolSpecSchema.parse(spec).name)).toEqual(['read_file', 'list_dir', 'grep', 'glob']);
  expect(WORKSPACE_READ_TOOL_SPECS.every(spec => spec.toolClass === 'read')).toBe(true);
});

it('reads the owner-case file (1.25 MB markdown, 10 KB lines) through bounded views with exact continuations, never whole', async () => {
  // Legacy owner case: the model reached for shell sed/awk (25 approvals) because read_file could not handle such lines.
  const longLine = `| ${'x'.repeat(10_240)} |`;
  const doc = Array.from({ length: 125 }, (_, i) => `## Section ${i + 1}\n\n${longLine}\n${'text line\n'.repeat(3)}`).join('\n');
  expect(Buffer.byteLength(doc)).toBeGreaterThan(1_250_000);
  const { root } = await workspace({ 'docs/MASTER-PLAN.md': doc });
  const tools = await createWorkspaceReadTools(root);
  const plain = await tools.execute('read_file', { path: 'docs/MASTER-PLAN.md' });
  expect(plain.status).toBe('ok');
  expect(Buffer.byteLength(plain.text)).toBeLessThanOrEqual(16_384);
  expect(meta(plain.text)).toMatch(/^\[deckent\] read_file: mode=range totalLines=\d+ range=1-\d+ returned=\d+ hasMore=true nextStartLine=\d+/);
  const outline = await tools.execute('read_file', { path: 'docs/MASTER-PLAN.md', mode: 'outline' });
  expect(meta(outline.text)).toMatch(/mode=outline bytes=\d+ totalLines=\d+ longestLine=L\d+:10244B .* headings=125/);
  expect(outline.text).toContain('## Section 1');
  const line = await tools.execute('read_file', { path: 'docs/MASTER-PLAN.md', startLine: 3, endLine: 3 });
  const marker = /\[… (\d+) bytes elided; re-read \{startLine: 3, endLine: 3, lineByteOffset: (\d+)\}\]/.exec(line.text);
  expect(marker).not.toBeNull();
  const rest = await tools.execute('read_file', { path: 'docs/MASTER-PLAN.md', startLine: 3, endLine: 3, lineByteOffset: Number(marker![2]) });
  expect(rest.text).toContain(`[… ${marker![2]} bytes before lineByteOffset]`);
  const search = await tools.execute('read_file', { path: 'docs/MASTER-PLAN.md', pattern: 'Section 7\\b', context: 1 });
  expect(meta(search.text)).toContain('mode=search'); expect(search.text).toContain('## Section 7');
});

it('keeps every read inside the workspace: traversal, absolute paths, symlink escapes and protected paths are refused', async () => {
  const { base, root } = await workspace({ 'src/a.ts': 'export const a = 1;\n', '.env': 'TOKEN=secret\n', 'keys/server.pem': 'PEM\n', '.git/config': '[core]\n' });
  await writeFile(join(base, 'outside.txt'), 'outside secret\n');
  await symlink(join(base, 'outside.txt'), join(root, 'link.txt'));
  await symlink(join(root, '.env'), join(root, 'env-link'));
  const tools = await createWorkspaceReadTools(root);
  for (const [path, error] of [['../outside.txt', 'path-outside-workspace'], [join(base, 'outside.txt'), 'path-outside-workspace'], ['link.txt', 'path-outside-workspace'],
    ['.env', 'path-denied'], ['env-link', 'path-denied'], ['keys/server.pem', 'path-denied'], ['.git/config', 'path-denied'], ['missing.ts', 'not-found']] as const) {
    const result = await tools.execute('read_file', { path });
    expect(result, path).toMatchObject({ status: 'error' }); expect(result.text, path).toContain(`error=${error}`);
    expect(result.text).not.toContain('secret');
  }
  const listing = await tools.execute('list_dir', {});
  expect(listing.text.split('\n')).toEqual(expect.arrayContaining(['src/', 'keys/', 'link.txt@']));
  expect(listing.text).not.toMatch(/^\.env$/m); expect(listing.text).toMatch(/protected entr/);
  const grep = await tools.execute('grep', { pattern: 'secret' });
  expect(grep.text).not.toContain('TOKEN'); expect(grep.text).toContain('no matches');
});

it('finds hits on long lines, reports skipped files instead of a bare "no matches", and bounds every result', async () => {
  const { root } = await workspace({ 'wide.md': `${'a'.repeat(20_000)}needle${'b'.repeat(20_000)}\n`, 'bin.dat': Buffer.from([1, 0, 2, 3]),
    'node_modules/pkg/index.js': 'needle\n', 'src/one.ts': 'const needle = 1;\n', 'many.txt': Array.from({ length: 400 }, (_, i) => `needle ${i}`).join('\n') });
  const tools = await createWorkspaceReadTools(root, { limits: { maxResultBytes: 4096 } });
  const wide = await tools.execute('grep', { pattern: 'needle', glob: '*.md' });
  expect(wide.text).toMatch(/^wide\.md:1:.*bytes elided; re-read/m);
  const all = await tools.execute('grep', { pattern: 'needle' });
  expect(Buffer.byteLength(all.text)).toBeLessThanOrEqual(4096);
  expect(all.text).toMatch(/truncated/); expect(all.text).not.toContain('node_modules');
  const none = await tools.execute('grep', { pattern: 'zzz-absent' });
  expect(none.text).toMatch(/no matches in \d+ scanned file\(s\); the search was not complete/); expect(none.text).toContain('skipped bin.dat (binary');
  expect((await tools.execute('glob', { pattern: '**/*.ts' })).text).toBe('src/one.ts');
  expect((await tools.execute('read_file', { path: 'bin.dat' })).text).toContain('error=binary');
  expect(await tools.execute('write_file', { path: 'x' })).toMatchObject({ status: 'error', text: '[deckent] write_file: error=unknown-tool' });
});

it('keeps the boundary under races: a swapped parent or root and a hard-linked protected file never yield their content (Astra 2072 R1)', async () => {
  const { base, root } = await workspace({ 'dir/a.txt': 'inside\n', '.env': 'DENIED-SENTINEL\n' });
  await mkdir(join(base, 'out')); await writeFile(join(base, 'out/a.txt'), 'OUTSIDE-SENTINEL\n');
  const scope = await createWorkspaceScope(root);
  const resolved = await scope.resolve('dir/a.txt');
  expect(resolved).toMatchObject({ ok: true, rel: 'dir/a.txt' });
  // The parent is replaced by a symlink to an outside directory between the check and the open.
  await rename(join(root, 'dir'), join(root, 'dir-old')); await symlink(join(base, 'out'), join(root, 'dir'));
  expect(await scope.open('dir/a.txt', 'file')).toEqual({ ok: false, error: 'path-changed' });
  await link(join(root, '.env'), join(root, 'alias.txt'));
  const tools = await createWorkspaceReadTools(root);
  const alias = await tools.execute('read_file', { path: 'alias.txt' });
  expect(alias.text).toContain('error=hardlink-refused'); expect(alias.text).not.toContain('SENTINEL');
  const grep = await tools.execute('grep', { pattern: 'SENTINEL' });
  expect(grep.text).not.toMatch(/SENTINEL\n|:1:/); expect(grep.text).toContain('skipped alias.txt (hard link refused)');
  // The whole root is swapped for a symlink to a look-alike tree outside.
  await mkdir(join(base, 'fake')); await writeFile(join(base, 'fake/a.txt'), 'OUTSIDE-SENTINEL\n');
  await rename(root, join(base, 'ws-old')); await symlink(join(base, 'fake'), root);
  const swapped = await tools.execute('read_file', { path: 'a.txt' });
  expect(swapped.status).toBe('error'); expect(swapped.text).not.toContain('SENTINEL');
});

it('stops a catastrophic regular expression on cancel without stalling the service, and never blocks on a FIFO (Astra 2072 R2)', async () => {
  const { root } = await workspace({ 'evil.txt': Array.from({ length: 4 }, () => `${'a'.repeat(32)}!`).join('\n') + '\n' });
  execFileSync('mkfifo', [join(root, 'pipe')]);
  const tools = await createWorkspaceReadTools(root);
  for (const call of [{ name: 'grep', args: { pattern: '^(a+)+$' } }, { name: 'read_file', args: { path: 'evil.txt', pattern: '^(a+)+$' } }]) {
    const controller = new AbortController(); let ticks = 0;
    const ticker = setInterval(() => { ticks++; }, 10);
    setTimeout(() => controller.abort(), 150);
    const started = performance.now();
    const result = await tools.execute(call.name, call.args, controller.signal);
    clearInterval(ticker);
    expect(result.text).toContain('error=cancelled');
    expect(performance.now() - started).toBeLessThan(2000);
    // The service thread kept running timers while the expression backtracked in the worker.
    expect(ticks).toBeGreaterThan(5);
  }
  const fifoStarted = performance.now();
  expect((await tools.execute('read_file', { path: 'pipe' })).text).toContain('error=not-a-file');
  expect((await tools.execute('grep', { pattern: 'x' })).text).toContain('1 special file(s) (FIFO, socket or device) not read');
  expect(performance.now() - fifoStarted).toBeLessThan(2000);
  const aborted = new AbortController(); aborted.abort();
  expect(await tools.execute('read_file', { path: 'evil.txt' }, aborted.signal)).toEqual({ status: 'error', text: '[deckent] read_file: error=cancelled' });
});

it('bounds every result branch, validates argument sizes and limits, and keeps multibyte text valid (Astra 2072 R3)', async () => {
  const { root } = await workspace({ 'ğ.txt': 'çok baytlı satır\n'.repeat(400) });
  const tools = await createWorkspaceReadTools(root, { limits: { maxResultBytes: 1024 } });
  const results = [await tools.execute('read_file', { path: 'ğ.txt', pattern: 'x'.repeat(2000) }), await tools.execute('read_file', { path: 'y'.repeat(3000) }),
    await tools.execute('read_file', { path: 'ğ.txt' }), await tools.execute('grep', { pattern: 'ç' }), await tools.execute('list_dir', {}), await tools.execute('glob', { pattern: '*' })];
  for (const result of results) { expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(1024); expect(Buffer.from(result.text).toString('utf8')).toBe(result.text); }
  expect((await tools.execute('read_file', { path: 'z'.repeat(5000) })).text).toContain('argument-too-long name=path');
  // Many skipped files with long names make the grep trailer alone larger than the cap: the final cut must still hold.
  const noisy: Record<string, Buffer> = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`${'n'.repeat(180)}${i}.bin`, Buffer.from([0, 1])]));
  const { root: noisyRoot } = await workspace(noisy);
  const noisyTools = await createWorkspaceReadTools(noisyRoot, { limits: { maxResultBytes: 1024 } });
  const trailer = await noisyTools.execute('grep', { pattern: 'x' });
  expect(Buffer.byteLength(trailer.text)).toBeLessThanOrEqual(1024); expect(trailer.text).toContain('result cut at the 1024-byte cap');
  await expect(createWorkspaceReadTools(root, { limits: { maxResultBytes: 10 } })).rejects.toThrow('WORKSPACE_READ_LIMITS_INVALID');
});

it('reports directories it could not scan instead of claiming no matches (Astra 2072 R4)', async () => {
  const deep = Array.from({ length: MAX_WALK_DEPTH + 3 }, (_, i) => `d${i}`).join('/');
  const { root } = await workspace({ [`${deep}/deep.txt`]: 'DEEP-MATCH\n', 'locked/inner.txt': 'LOCKED-MATCH\n', 'top.txt': 'nothing\n' });
  await chmod(join(root, 'locked'), 0o000);
  const tools = await createWorkspaceReadTools(root);
  const grep = await tools.execute('grep', { pattern: 'MATCH' });
  expect(grep.text).toContain('the search was not complete');
  expect(grep.text).toMatch(/beyond depth 32/); expect(grep.text).toMatch(/1 unreadable directory|1 director(y|ies) changed/);
  const glob = await tools.execute('glob', { pattern: '**/deep.txt' });
  expect(glob.text).toContain('no matches in the scanned part'); expect(glob.text).toContain('beyond depth 32');
});

it('refuses a walked file whose parent moved out of the workspace during the walk (Astra 2078 R1)', async () => {
  const { base, root } = await workspace({ 'dir/a.txt': 'inside\n', 'dir/b.txt': 'inside-b\n', 'later/c.txt': 'c\n' });
  const scope = await createWorkspaceScope(root);
  const outcomes: Record<string, string> = {};
  const incomplete = await walkWorkspaceFiles(scope, '', async (rel, parent, name) => {
    if (rel === 'dir/a.txt') {
      // After the entries of dir were read, dir leaves the workspace and its other file gets outside content.
      await rename(join(root, 'dir'), join(base, 'moved')); await writeFile(join(base, 'moved/b.txt'), 'OUTSIDE-SENTINEL\n');
      await rename(join(root, 'later'), join(base, 'later-moved')); await mkdir(join(base, 'later-moved-marker'));
    }
    const opened = await openWalkedFile(scope, parent, name, rel);
    outcomes[rel] = opened.ok ? 'opened' : opened.reason;
    if (opened.ok) await opened.handle.close();
    return true;
  });
  expect(outcomes['dir/a.txt']).toBe('changed during the walk');
  expect(outcomes['dir/b.txt']).toBe('changed during the walk');
  expect(outcomes['later/c.txt']).toBeUndefined();
  expect(incomplete.changed).toBeGreaterThanOrEqual(1);
});

it('matches globs without backtracking, so a hostile pattern cannot stall the service (Astra 2078 R2)', async () => {
  const match = (pattern: string, path: string) => createGlobMatcher(pattern)(path);
  expect([match('**/*.ts', 'a.ts'), match('**/*.ts', 'x/y/a.ts'), match('*.ts', 'x/a.ts'), match('src/**', 'src/a/b'), match('src/*/b', 'src/a/b'),
    match('a?c', 'abc'), match('a?c', 'a/c'), match('**/.env', '.env'), match('.env.*', '.env.local'), match('x.ts', 'x_ts')]).toEqual([true, true, false, true, true, true, false, true, true, false]);
  const { root } = await workspace({ [`${'a'.repeat(45)}`]: 'x\n', 'one.txt': 'y\n' });
  const tools = await createWorkspaceReadTools(root);
  let ticks = 0; const ticker = setInterval(() => { ticks++; }, 5);
  const started = performance.now();
  const hostile = `${'*a'.repeat(22)}b`;
  expect((await tools.execute('glob', { pattern: hostile })).text).toBe('[deckent] glob: no matches');
  expect((await tools.execute('grep', { pattern: 'x', glob: hostile })).text).toContain('no matches');
  clearInterval(ticker);
  expect(performance.now() - started).toBeLessThan(1000);
  expect(ticks).toBeGreaterThanOrEqual(0);
  expect((await tools.execute('glob', { pattern: '*'.repeat(600) })).text).toContain('argument-too-long');
});
