import { afterEach, expect, it } from 'vitest';
import { main } from '../../../src/surfaces/index.js';
import { unifiedDiff } from '../../../src/adapters/core/workspace-write/index.js';

const out: string[] = [];
afterEach(() => { out.length = 0; });
const file = (text: string, mode = '100644') => ({ mode, text, digest: 'a'.repeat(64) });
const result = { schemaVersion: 1, receipt: {}, application: 'not-applied', patch: { changes: [
  { path: 'added.txt', before: null, after: file('one\ntwo\n') },
  { path: 'deleted.txt', before: file('gone\nlines\n'), after: null },
  { path: 'modified.txt', before: file('a\nb\nc\n'), after: file('a\nB\nc\nd\n') },
  { path: 'run.sh', before: file('#!/bin/sh\n'), after: file('#!/bin/sh\n', '100755') },
] } };
const base = ['task', 'patch-preview', '--scope', 's', '--run', 'r', '--task', 't', '--attempt', 'a', '--generation', '1', '--layout-revision', 'l'];
const ctx = () => ({ env: { HOME: '/tmp/deckent-patch-preview-test', NO_COLOR: '1' }, stdout: { write(v: string) { out.push(v); } }, stderr: { write(v: string) { out.push(v); } },
  previewWorkspacePatch: async () => result, renderUnifiedDiff: unifiedDiff } as never);

it('prints a unified diff by default and with --diff, without JSON', async () => {
  for (const extra of [[], ['--diff']]) {
    out.length = 0;
    expect(await main([...base, ...extra], ctx())).toBe(0);
    const text = out.join('');
    expect(text).toContain('--- /dev/null\n+++ b/added.txt');
    expect(text).toContain('--- a/deleted.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-gone\n-lines');
    expect(text).toContain('--- a/modified.txt\n+++ b/modified.txt');
    expect(text).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
    expect(text).toContain('mode 100644 -> 100755 run.sh');
    expect(text).not.toContain('"digest"');
  }
});
it('prints per-file counts and a summary with --stat', async () => {
  expect(await main([...base, '--stat'], ctx())).toBe(0);
  const text = out.join('');
  expect(text).toContain('added.txt | +2 -0');
  expect(text).toContain('deleted.txt | +0 -2');
  expect(text).toContain('modified.txt | +2 -1');
  expect(text).toContain('run.sh | +0 -0');
  expect(text).toContain('4 files, +4 -3');
  expect(text).not.toContain('@@');
});
it('keeps --json output as the full result', async () => {
  expect(await main([...base, '--json'], ctx())).toBe(0);
  expect(JSON.parse(out.join(''))).toEqual(result);
});
it.each([[['--stat', '--diff']], [['--stat', '--json']], [['--diff', '--json']]])('rejects %j as a usage error', async extra => {
  expect(await main([...base, ...extra], ctx())).not.toBe(0);
  expect(out.join('')).toContain('Usage');
});
