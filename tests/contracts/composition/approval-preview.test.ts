import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { APPROVAL_PREVIEW_MAX_BYTES, boundApprovalPreview, sweepFullPreviews } from '#composition/core/agent-turn/index.js';
import { resolveProductLayout } from '#platform/index.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

it('bounds an approval preview in UTF-8 bytes under a first-line marker, whole lines first, never splitting a character (Astra 2094 R3)', () => {
  expect(boundApprovalPreview('small\ntext')).toBe('small\ntext');
  const lines = Array.from({ length: 4_000 }, (_, index) => `+line ${index} ${'ğ'.repeat(10)}`).join('\n');
  const cut = boundApprovalPreview(lines, '/state/approval-previews/x.txt');
  expect(Buffer.byteLength(cut, 'utf8')).toBeLessThanOrEqual(APPROVAL_PREVIEW_MAX_BYTES);
  const [marker, ...shown] = cut.split('\n');
  expect(marker).toMatch(/^\[Deckent: preview cut to (\d+) of 4000 lines \(\d+ of \d+ bytes\); whole text sha256 [0-9a-f]{64}; complete at \/state\/approval-previews\/x\.txt\]$/);
  expect(shown.length).toBe(Number(/cut to (\d+)/.exec(marker!)![1])); expect(shown[0]).toBe(`+line 0 ${'ğ'.repeat(10)}`);
  // Fewer characters than the bound but more bytes (10,000 × 2-byte): still cut, the bound is in bytes.
  const dense = boundApprovalPreview('ş'.repeat(10_000));
  expect(Buffer.byteLength(dense, 'utf8')).toBeLessThanOrEqual(APPROVAL_PREVIEW_MAX_BYTES); expect(dense.split('\n')[0]).toMatch(/^\[Deckent: preview cut/);
  // One huge multi-byte line is cut at a character boundary; without a kept file the marker says so.
  const single = boundApprovalPreview('ş'.repeat(40_000));
  expect(Buffer.byteLength(single, 'utf8')).toBeLessThanOrEqual(APPROVAL_PREVIEW_MAX_BYTES);
  expect(single).not.toContain('�'); expect(single.split('\n')[0]).toMatch(/; not kept\]$/); expect(single.split('\n')[1]).toMatch(/^ş+ …$/);
});

it('sweeps kept previews at service start and tolerates a missing directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dn-previews-')); roots.push(root);
  const layout = resolveProductLayout({ projectRoot: root, root: join(root, 'data') });
  await mkdir(join(root, 'data'), { mode: 0o700 });
  expect(await sweepFullPreviews(layout)).toBe(0);
  await mkdir(join(root, 'data', 'state', 'approval-previews'), { recursive: true, mode: 0o700 });
  await writeFile(join(root, 'data', 'state', 'approval-previews', `${'a'.repeat(64)}.txt`), 'diff', { mode: 0o600 });
  await writeFile(join(root, 'data', 'state', 'approval-previews', 'keep.me'), 'other', { mode: 0o600 });
  expect(await sweepFullPreviews(layout)).toBe(1);
  expect(await readdir(join(root, 'data', 'state', 'approval-previews'))).toEqual(['keep.me']);
});
