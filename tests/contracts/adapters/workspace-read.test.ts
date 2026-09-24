import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createWorkspaceReadTools, WORKSPACE_READ_TOOL_SPECS } from '#adapters/index.js';
import { agentToolSpecSchema } from '#domain/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

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
  expect(listing.text.split('\n')).toEqual(expect.arrayContaining(['src/', 'keys/', 'link.txt']));
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
  expect(none.text).toMatch(/no matches in \d+ scanned file\(s\); 1 file\(s\) not fully scanned/); expect(none.text).toContain('skipped bin.dat (binary');
  expect((await tools.execute('glob', { pattern: '**/*.ts' })).text).toBe('src/one.ts');
  expect((await tools.execute('read_file', { path: 'bin.dat' })).text).toContain('error=binary');
  expect(await tools.execute('write_file', { path: 'x' })).toMatchObject({ status: 'error', text: '[deckent] write_file: error=unknown-tool' });
});
