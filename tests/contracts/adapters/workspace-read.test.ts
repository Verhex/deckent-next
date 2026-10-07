import { chmod, link, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createGlobMatcher, createWorkspaceReadTools, createWorkspaceScope, DEFAULT_WORKSPACE_READ_LIMITS, MAX_WALK_DEPTH, openWalkedFile, walkWorkspaceFiles,
  WORKSPACE_READ_TOOL_SPECS } from '#adapters/index.js';
import { WORKSPACE_DESCRIPTOR_CUSTODY_AVAILABLE } from '../../fixtures/workspace-descriptor-custody.js';
import { agentToolSpecSchema } from '#domain/index.js';
import { summarizeAgentToolResult } from '#surfaces/core/terminal-kit/index.js';

const custodyIt = it.skipIf(!WORKSPACE_DESCRIPTOR_CUSTODY_AVAILABLE);
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
  expect(DEFAULT_WORKSPACE_READ_LIMITS.maxResultBytes).toBe(65_536);
});

custodyIt('[requires Linux /proc/self/fd custody] reads the owner-case file (1.25 MB markdown, 10 KB lines) through bounded views with exact continuations, never whole', async () => {
  // Legacy owner case: the model reached for shell sed/awk (25 approvals) because read_file could not handle such lines.
  const longLine = `| ${'x'.repeat(10_240)} |`;
  const doc = Array.from({ length: 125 }, (_, i) => `## Section ${i + 1}\n\n${longLine}\n${'text line\n'.repeat(3)}`).join('\n');
  expect(Buffer.byteLength(doc)).toBeGreaterThan(1_250_000);
  const { root } = await workspace({ 'docs/MASTER-PLAN.md': doc });
  const tools = await createWorkspaceReadTools(root);
  const plain = await tools.execute('read_file', { path: 'docs/MASTER-PLAN.md' });
  expect(plain.status).toBe('ok');
  expect(Buffer.byteLength(plain.text)).toBeLessThanOrEqual(DEFAULT_WORKSPACE_READ_LIMITS.maxResultBytes);
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

custodyIt('[requires Linux /proc/self/fd custody] keeps every read inside the workspace: traversal, absolute paths, symlink escapes and protected paths are refused', async () => {
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

custodyIt('[requires Linux /proc/self/fd custody] finds hits on long lines, reports skipped files instead of a bare "no matches", and bounds every result', async () => {
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

custodyIt('[requires Linux /proc/self/fd custody] keeps the boundary under races: a swapped parent or root and a hard-linked protected file never yield their content (Astra 2072 R1)', async () => {
  const { base, root } = await workspace({ 'dir/a.txt': 'inside\n', '.env': 'DENIED-SENTINEL\n' });
  await mkdir(join(base, 'out')); await writeFile(join(base, 'out/a.txt'), 'OUTSIDE-SENTINEL\n');
  const scope = await createWorkspaceScope(root);
  const resolved = await scope.resolve('dir/a.txt');
  expect(resolved).toMatchObject({ ok: true, rel: 'dir/a.txt' });
  // The parent is replaced by a symlink to an outside directory between the check and the open.
  await rename(join(root, 'dir'), join(root, 'dir-old')); await symlink(join(base, 'out'), join(root, 'dir'));
  // B4 diagnosis: the refusal says where (the swapped first segment, not followed) and the errno; never the outside path.
  const swappedParent = await scope.open('dir/a.txt', 'file');
  expect(swappedParent).toMatchObject({ ok: false, error: 'path-changed', diagnostic: { step: 'open:1' } });
  expect(!swappedParent.ok && ['ELOOP', 'ENOTDIR'].includes(swappedParent.diagnostic?.errno ?? '')).toBe(true);
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

custodyIt('[requires Linux /proc/self/fd custody] stops a catastrophic regular expression on cancel without stalling the service, and never blocks on a FIFO (Astra 2072 R2)', async () => {
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

it('validates argument sizes and configured limits before any descriptor read (Astra 2072 R3)', async () => {
  await expect(createWorkspaceReadTools('/never-opened', { limits: { maxResultBytes: 10 } })).rejects.toThrow('WORKSPACE_READ_LIMITS_INVALID');
  const tools = await createWorkspaceReadTools(process.cwd(), { limits: { maxResultBytes: 1024 } });
  expect((await tools.execute('read_file', { path: 'z'.repeat(5000) })).text).toContain('argument-too-long name=path');
});

custodyIt('[requires Linux /proc/self/fd custody] bounds every result branch and keeps multibyte text valid (Astra 2072 R3)', async () => {
  const { root } = await workspace({ 'ğ.txt': 'çok baytlı satır\n'.repeat(400) });
  const tools = await createWorkspaceReadTools(root, { limits: { maxResultBytes: 1024 } });
  const results = [await tools.execute('read_file', { path: 'ğ.txt', pattern: 'x'.repeat(2000) }), await tools.execute('read_file', { path: 'y'.repeat(3000) }),
    await tools.execute('read_file', { path: 'ğ.txt' }), await tools.execute('grep', { pattern: 'ç' }), await tools.execute('list_dir', {}), await tools.execute('glob', { pattern: '*' })];
  for (const result of results) { expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(1024); expect(Buffer.from(result.text).toString('utf8')).toBe(result.text); }
  // Many skipped files with long names make the grep trailer alone larger than the cap: the final cut must still hold.
  const noisy: Record<string, Buffer> = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`${'n'.repeat(180)}${i}.bin`, Buffer.from([0, 1])]));
  const { root: noisyRoot } = await workspace(noisy);
  const noisyTools = await createWorkspaceReadTools(noisyRoot, { limits: { maxResultBytes: 1024 } });
  const trailer = await noisyTools.execute('grep', { pattern: 'x' });
  expect(Buffer.byteLength(trailer.text)).toBeLessThanOrEqual(1024); expect(trailer.text).toContain('result cut at the 1024-byte cap');
});

custodyIt('[requires Linux /proc/self/fd custody] reports directories it could not scan instead of claiming no matches (Astra 2072 R4)', async () => {
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

custodyIt('[requires Linux /proc/self/fd custody] refuses a walked file whose parent moved out of the workspace during the walk (Astra 2078 R1)', async () => {
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

it('matches the shared glob grammar without requiring descriptor custody', () => {
  const match = (pattern: string, path: string) => createGlobMatcher(pattern)(path);
  expect([match('**/*.ts', 'a.ts'), match('**/*.ts', 'x/y/a.ts'), match('*.ts', 'x/a.ts'), match('src/**', 'src/a/b'), match('src/*/b', 'src/a/b'),
    match('a?c', 'abc'), match('a?c', 'a/c'), match('**/.env', '.env'), match('.env.*', '.env.local'), match('x.ts', 'x_ts')]).toEqual([true, true, false, true, true, true, false, true, true, false]);
  expect(createGlobMatcher(`${'*a'.repeat(22)}b`)('a'.repeat(45))).toBe(false);
});

custodyIt('[requires Linux /proc/self/fd custody] matches globs without backtracking, so a hostile pattern cannot stall the service (Astra 2078 R2)', async () => {
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

// D3 (TL-B, analysis §5/§8 D3, owner): 16 KiB forced typical 15-20 KB source files into a second round every time; the
// default rises to 64 KiB, and `terminal.chat.readResultMaxBytes` (composition, not tested here) can still narrow it.
custodyIt('[requires Linux /proc/self/fd custody] reads an 18-60 KB file whole in one call under the new 64 KiB default (owner: fewer rounds)', async () => {
  expect(DEFAULT_WORKSPACE_READ_LIMITS.maxResultBytes).toBe(65_536);
  const body = Array.from({ length: 900 }, (_, i) => `line ${i} of a typical source file with some real content here`).join('\n') + '\n';
  expect(Buffer.byteLength(body)).toBeGreaterThan(18_000); expect(Buffer.byteLength(body)).toBeLessThan(60_000);
  const { root } = await workspace({ 'src/big.ts': body });
  const tools = await createWorkspaceReadTools(root);
  const result = await tools.execute('read_file', { path: 'src/big.ts' });
  expect(result.status).toBe('ok');
  expect(meta(result.text)).toMatch(/hasMore=false/);
  expect(result.text).toContain('line 899 of a typical source file');
  // A narrower configured limit (as `readResultMaxBytes` would set) still splits the same file.
  const narrow = await createWorkspaceReadTools(root, { limits: { maxResultBytes: 4096 } });
  expect(meta((await narrow.execute('read_file', { path: 'src/big.ts' })).text)).toMatch(/hasMore=true/);
});

// D3: grep's `context` (0-5) and `maxHits` mirror read_file's `context`/`maxMatches` naming so the model does not have
// to guess which read tool accepts which field (analysis §5: "grep · invalid arguments" from this exact asymmetry).
custodyIt('[requires Linux /proc/self/fd custody] accepts grep context (bounded to 5) and maxHits (bounded to the 200 hit cap), unchanged at context=0 (default)', async () => {
  const { root } = await workspace({ 'many.txt': Array.from({ length: 10 }, (_, i) => `needle ${i}`).join('\n') + '\n' });
  const tools = await createWorkspaceReadTools(root);
  const plain = await tools.execute('grep', { pattern: 'needle' });
  expect(plain.text.split('\n')).toEqual(['many.txt:1:needle 0', 'many.txt:2:needle 1', 'many.txt:3:needle 2', 'many.txt:4:needle 3', 'many.txt:5:needle 4',
    'many.txt:6:needle 5', 'many.txt:7:needle 6', 'many.txt:8:needle 7', 'many.txt:9:needle 8', 'many.txt:10:needle 9', '[deckent] grep: matches=10']);
  const capped = await tools.execute('grep', { pattern: 'needle', maxHits: 3 });
  expect(capped.text.split('\n')).toEqual(['many.txt:1:needle 0', 'many.txt:2:needle 1', 'many.txt:3:needle 2', '[deckent] grep: truncated (3 hits cap); narrow with path or glob',
    '[deckent] grep: matches=3+']);
  const { root: sparse } = await workspace({ 'wide.txt': Array.from({ length: 12 }, (_, i) => i === 2 || i === 9 ? `needle here` : `line ${i}`).join('\n') + '\n' });
  const sparseTools = await createWorkspaceReadTools(sparse);
  const withContext = await sparseTools.execute('grep', { pattern: 'needle', context: 1 });
  expect(withContext.text).toBe(['wide.txt:2-line 1', 'wide.txt:3:needle here', 'wide.txt:4-line 3', '--',
    'wide.txt:9-line 8', 'wide.txt:10:needle here', 'wide.txt:11-line 10', '[deckent] grep: matches=2'].join('\n'));
  // The card's own acceptance values (D3): grep {context:2, maxHits:5}.
  const wide = await sparseTools.execute('grep', { pattern: 'needle', context: 2, maxHits: 5 });
  expect(wide.text).toBe(['wide.txt:1-line 0', 'wide.txt:2-line 1', 'wide.txt:3:needle here', 'wide.txt:4-line 3', 'wide.txt:5-line 4', '--',
    'wide.txt:8-line 7', 'wide.txt:9-line 8', 'wide.txt:10:needle here', 'wide.txt:11-line 10', 'wide.txt:12-line 11', '[deckent] grep: matches=2'].join('\n'));
  // Out-of-range values clamp instead of erroring (matching read_file's context/maxMatches convention).
  const clamped = await sparseTools.execute('grep', { pattern: 'needle', context: 99, maxHits: 0 });
  expect(clamped.text).not.toContain('undefined'); expect(clamped.status).toBe('ok');
});

// Astra 2143 R2 (ported from astra-2142-extra.test.ts.txt): two matches close enough that their context windows touch
// or overlap must both keep their ':' hit marker. The old code marked a block's lines against only the match that
// produced that block (`j === index`), so a second match already covered by the first match's trailing context lost
// its ':' forever and was shown as plain context (`-`) instead.
custodyIt('[requires Linux /proc/self/fd custody] marks every real hit with \':\' even when context windows are adjacent or overlapping (Astra 2143 R2)', async () => {
  const { root } = await workspace({ 'a.txt': 'before\nMATCH one\nMATCH two\nafter\n' });
  const tools = await createWorkspaceReadTools(root);
  const adjacent = await tools.execute('grep', { pattern: 'MATCH', context: 1 });
  expect(adjacent.text).toBe(['a.txt:1-before', 'a.txt:2:MATCH one', 'a.txt:3:MATCH two', 'a.txt:4-after', '[deckent] grep: matches=2'].join('\n'));
  const { root: overlap } = await workspace({ 'b.txt': 'x\nMATCH a\nmid\nMATCH b\ny\n' });
  const overlapTools = await createWorkspaceReadTools(overlap);
  const wide = await overlapTools.execute('grep', { pattern: 'MATCH', context: 2 });
  expect(wide.text).toBe(['b.txt:1-x', 'b.txt:2:MATCH a', 'b.txt:3-mid', 'b.txt:4:MATCH b', 'b.txt:5-y', '[deckent] grep: matches=2'].join('\n'));
  // A match whose whole context window was already printed by an earlier, still-open block (here: two adjacent
  // matches at the very end of the file) must not push an empty extra row — that would only add a stray trailing
  // newline to the result.
  const { root: eof } = await workspace({ 'c.txt': 'MATCH a\nMATCH b\n' });
  const tail = await (await createWorkspaceReadTools(eof)).execute('grep', { pattern: 'MATCH', context: 1 });
  expect(tail.text).toBe('c.txt:1:MATCH a\nc.txt:2:MATCH b\n[deckent] grep: matches=2');
});

// Astra 2145 R2 (ported from astra-2144-grep.test.ts.txt): the terminal's match count comes from the producer's exact count, never from
// reading the free text. A workspace file may have ':' in its name, so `path:line:text` cannot be split reliably; the producer states
// `[deckent] grep: matches=N` (N = the ':'-marked hit lines it actually returned, `+` when it returned less than it found) as its last line.
custodyIt('[requires Linux /proc/self/fd custody] counts grep hits from the producer\'s own last meta line, also for paths with \':\' in them (Astra 2145 R2)', async () => {
  const { root } = await workspace({ 'report:2026.txt': 'MATCH\n' });
  const tools = await createWorkspaceReadTools(root);
  const single = await tools.execute('grep', { path: 'report:2026.txt', pattern: 'MATCH', context: 0 });
  expect(single).toEqual({ status: 'ok', text: 'report:2026.txt:1:MATCH\n[deckent] grep: matches=1' });
  expect(summarizeAgentToolResult('grep', single.text)).toEqual({ kind: 'matches', count: 1, more: false });
  // Numeric ':' parts in a path, a timestamped context row, adjacent, overlapping and disjoint context windows — one walk.
  const { root: mixed } = await workspace({ 'report:2026.txt': 'MATCH\n', 't:12:34.log': '2026-09-28 12:34:56 boot\nMATCH at 12:34:57\n12:34:58 done\n',
    'w.txt': 'a\nMATCH 1\nMATCH 2\nb\nMATCH 3\nc\nd\ne\nf\nMATCH 4\n' });
  const walk = await (await createWorkspaceReadTools(mixed)).execute('grep', { pattern: 'MATCH', context: 1 });
  expect(walk.text.split('\n').at(-1)).toBe('[deckent] grep: matches=6');
  expect(summarizeAgentToolResult('grep', walk.text)).toEqual({ kind: 'matches', count: 6, more: false });
});

// `maxHits` caps the hits that open a context window (seed hits). Further hits inside an opened window are shown, marked ':' and counted;
// reaching the cap is stated (`+`). With context 0 every window is one line, so `maxHits` is the number of hits shown.
custodyIt('[requires Linux /proc/self/fd custody] documents maxHits as the seed-hit cap: hits inside an opened window are shown, counted and the cap is stated (Astra 2145 R2)', async () => {
  const { root } = await workspace({ 'a.txt': 'MATCH\n'.repeat(10) });
  const tools = await createWorkspaceReadTools(root);
  const seeded = await tools.execute('grep', { path: 'a.txt', pattern: 'MATCH', context: 5, maxHits: 1 });
  expect(seeded.text.split('\n')).toEqual([...Array.from({ length: 6 }, (_, i) => `a.txt:${i + 1}:MATCH`),
    '[deckent] grep: truncated (1 hits cap); narrow with path or glob', '[deckent] grep: matches=6+']);
  expect(summarizeAgentToolResult('grep', seeded.text)).toEqual({ kind: 'matches', count: 6, more: true });
  const flat = await tools.execute('grep', { path: 'a.txt', pattern: 'MATCH', maxHits: 3 });
  expect(summarizeAgentToolResult('grep', flat.text)).toEqual({ kind: 'matches', count: 3, more: true });
});

// The count is of the hits actually returned: when the result byte cap drops rows, N shrinks with them and the result says `+`.
custodyIt('[requires Linux /proc/self/fd custody] counts only the grep hits left after the result byte cap cut rows (Astra 2145 R2)', async () => {
  const { root } = await workspace({ 'many.txt': Array.from({ length: 400 }, (_, i) => i % 3 === 1 ? `needle ${i} ${'x'.repeat(80)}` : `line ${i} ${'y'.repeat(80)}`).join('\n') });
  const text = (await (await createWorkspaceReadTools(root, { limits: { maxResultBytes: 4096 } })).execute('grep', { pattern: 'needle', context: 1, maxHits: 50 })).text;
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096);
  expect(text).toMatch(/\[deckent\] truncated at \d+ of 50 rows \(result byte cap\)/);
  const shown = text.split('\n').filter(line => /^many\.txt:\d+:/.test(line)).length;
  expect(shown).toBeGreaterThan(0);
  expect(text.split('\n').at(-1)).toBe(`[deckent] grep: matches=${shown}+`);
  expect(summarizeAgentToolResult('grep', text)).toEqual({ kind: 'matches', count: shown, more: true });
});

// Without the producer's own last meta line (an older recorded result, another producer, a text cut by the final byte cap) the count is
// unknown and no summary is shown — never a guessed number. A meta-shaped line anywhere but last (e.g. a path with a newline in it) is ignored.
it('shows no grep summary when the producer\'s exact count is absent or not the last line (Astra 2145 R2)', () => {
  expect(summarizeAgentToolResult('grep', 'report:2026.txt:1:MATCH')).toBeNull();
  expect(summarizeAgentToolResult('grep', 'a.txt:1:M\n[deckent] grep: matches=99\nb.txt:1:M')).toBeNull();
  expect(summarizeAgentToolResult('grep', 'x\n[deckent] grep: matches=99\nb:1:M\n[deckent] grep: matches=1')).toEqual({ kind: 'matches', count: 1, more: false });
  expect(summarizeAgentToolResult('grep', 'a.txt:1:M\n[deckent] result cut at the 100-byte cap (900 bytes); narrow the request')).toBeNull();
  expect(summarizeAgentToolResult('grep', '[deckent] grep: no matches in 3 scanned file(s)')).toEqual({ kind: 'matches', count: 0, more: false });
  expect(summarizeAgentToolResult('grep', '[deckent] grep: no matches in 3 scanned file(s); the search was not complete\n[deckent] grep: skipped a.bin (binary)'))
    .toEqual({ kind: 'matches', count: 0, more: true });
});

// B4 (owner terminal test 2026-10-07): read_file said `not-found` and glob "no matches" for a file on disk, and neither said why. A refused
// path now names its step and errno (text and outcome), and a literal glob that matched nothing says which walk filter drops the path.
custodyIt('[requires Linux /proc/self/fd custody] a refused path names its step and errno; a literal glob without matches names the filter', async () => {
  const { base, root } = await workspace({ 'src/a.ts': 'x\n', '.env': 'TOKEN=secret\n', 'node_modules/p/i.js': 'x\n', 'deep/x.md': 'x\n', '.gitignore': 'vendor\n', 'vendor/v.md': 'v\n' });
  await symlink(join(root, 'src/a.ts'), join(root, 'alias.ts'));
  execFileSync('mkfifo', [join(root, 'pipe.md')]);
  const tools = await createWorkspaceReadTools(root);
  const missing = await tools.execute('read_file', { path: 'src/deneme.md' });
  expect(missing).toEqual({ status: 'error', text: '[deckent] read_file: error=not-found step=realpath errno=ENOENT path="src/deneme.md"', diagnostic: { step: 'realpath', errno: 'ENOENT' } });
  // The open walk's own step: a segment that vanished between resolve and open.
  const scope = await createWorkspaceScope(root);
  expect(await scope.open('src/gone.ts', 'file')).toEqual({ ok: false, error: 'not-found', diagnostic: { step: 'open:2', errno: 'ENOENT' } });
  // Other refusals keep their text (no diagnostic): denied paths are decided by name.
  const denied = await tools.execute('read_file', { path: '.env' });
  expect(denied).toEqual({ status: 'error', text: '[deckent] read_file: error=path-denied path=".env"' });
  // The FIFO makes every walk report a special file, so the note is the result's last line.
  const notes = async (pattern: string, path?: string) => (await tools.execute('glob', { pattern, ...(path ? { path } : {}) })).text;
  const note = async (pattern: string, path?: string) => (await notes(pattern, path)).split('\n').at(-1);
  expect(await note('src/deneme.md')).toBe('[deckent] glob: path="src/deneme.md" not there (error=not-found step=realpath errno=ENOENT)');
  expect(await note('.env')).toBe('[deckent] glob: path=".env" filter=deny (a protected path is never listed)');
  expect(await note('alias.ts')).toBe('[deckent] glob: path="alias.ts" filter=symlink (the walk does not follow links)');
  expect(await note('node_modules/p/i.js')).toBe('[deckent] glob: path="node_modules/p/i.js" filter=ignored name="node_modules" (.gitignore or baseline name)');
  expect(await note('vendor/v.md')).toBe('[deckent] glob: path="vendor/v.md" filter=ignored name="vendor" (.gitignore or baseline name)');
  expect(await note('pipe.md')).toBe('[deckent] glob: path="pipe.md" filter=none open=not-a-file');
  // A wildcard pattern gets no note; a match gets none either; nothing outside the workspace is named.
  for (const pattern of ['src/*.md', '../x.md']) expect(await notes(pattern)).not.toContain('glob: path=');
  expect((await notes('src/a.ts')).split('\n')[0]).toBe('src/a.ts'); expect(await notes('src/a.ts')).not.toContain('glob: path=');
  for (const text of [missing.text, await notes('src/deneme.md')]) { expect(text).not.toContain(base); expect(text).not.toContain('secret'); }
});
