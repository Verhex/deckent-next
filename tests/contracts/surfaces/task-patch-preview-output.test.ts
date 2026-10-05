import { afterEach, expect, it } from 'vitest';
import { main } from '../../../src/surfaces/index.js';
import { unifiedDiff } from '../../../src/adapters/core/workspace-write/index.js';
import { patchDigest, patchExclusions, WorkspaceIntegrationApplication, WorkspacePatchApplication, type WorkspacePatch } from '#engine/index.js';

const out: string[] = [];
afterEach(() => { out.length = 0; });
const file = (text: string, mode = '100644') => ({ mode, text, digest: 'a'.repeat(64) });
const result = { schemaVersion: 1, receipt: {}, application: 'not-applied', scope: { schemaVersion: 1, matcher: 1, mode: 'warn', status: 'unscoped' }, patch: { changes: [
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
    expect(text).toContain('Scope: unscoped');
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

it('carries real retained patch advice through prepare, preview variants and integration check, human EN/TR and exact JSON', async () => {
  const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: 'l' };
  const patch: WorkspacePatch = { schemaVersion: 1, kind: 'workspace-patch', identity, baseCommit: 'b'.repeat(40), snapshotDigest: 'd'.repeat(64),
    source: { schemaVersion: 1, adapter: { id: 'git', version: 1 }, sourceFingerprint: 'f'.repeat(64) },
    exclusions: { ...patchExclusions, excludedSegments: [...patchExclusions.excludedSegments], excludedPrefixes: [...patchExclusions.excludedPrefixes] },
    changes: [{ path: 'notes/new.txt', before: null, after: { mode: '100644', text: 'new\n', digest: patchDigest('new\n') } }] };
  const artifact = Buffer.from(JSON.stringify(patch));
  const receipt = { schemaVersion: 1 as const, scopeId: 's', digest: patchDigest(artifact), byteLength: artifact.length };
  const artifacts = { async put() { return receipt; }, async read() { return artifact; } };
  const dispatch = { request: { identity }, owner: 'o', terminal: { handle: 'h' }, patch: receipt };
  const store = { async loadBoundDispatch() { return dispatch; }, async retainDispatchPatch() { return dispatch; },
    async loadBoundTask() { return { id: 't', kind: 'coding', dependencies: [], acceptanceCriteria: ['exit'],
      workInput: { schemaVersion: 1, task: 'Edit notes.', scope: { paths: ['notes'] }, acceptance: 'Done.',
        model: { channelId: 'c', modelId: 'm', auxiliaryModelIds: [] } } }; } };
  const verifier = { async verify() { return { id: 'p', issuer: 'i', subject: 'u', assurance: 'os-user' as const, scopeIds: ['s'] }; } };
  const authorization = { async authorizeIdentity() {} };
  const patches = new WorkspacePatchApplication(store as never, artifacts, verifier, authorization, 65536, 'enforce');
  const prepare = () => patches.prepare(identity, { async capture() { return patch; } }, store as never);
  const integration = new WorkspaceIntegrationApplication(patches, { async observe() {
    return { digest: 'e'.repeat(64), source: 'git', head: 'b'.repeat(40) };
  } } as never, verifier, authorization, artifacts, 65536);
  const expectedPatch = await prepare(), expectedCheck = await integration.check(identity);
  const commandContext = { env: { HOME: '/tmp/deckent-scope-hint-test', NO_COLOR: '1' },
    stdout: { write(v: string) { out.push(v); } }, stderr: { write(v: string) { out.push(v); } },
    prepareWorkspacePatch: prepare, previewWorkspacePatch: () => patches.preview(identity),
    checkWorkspaceIntegration: () => integration.check(identity), renderUnifiedDiff: unifiedDiff };
  for (const [action, extra] of [['patch-prepare', []], ['patch-preview', []], ['patch-preview', ['--stat']],
    ['patch-preview', ['--diff']], ['integration-check', []]] as const) {
    const command = [base[0]!, action, ...base.slice(2), ...extra];
    for (const locale of ['en', 'tr']) {
      out.length = 0;
      expect(await main([...command, '--lang', locale], commandContext as never)).toBe(0);
      const text = out.join('');
      expect(text).toContain(locale === 'en' ? 'Did you mean notes/** instead of notes?' : 'notes yerine notes/** mi demek istediniz?');
      expect(text).toContain(locale === 'en' ? 'this suggestion does not change' : 'bu öneri görevin kapsamını değiştirmez');
      expect(text).toContain(locale === 'en' ? 'integration and delivery of this patch are refused' : 'entegrasyonu ve teslimi reddedilir');
    }
    if (extra.length) continue; // --stat/--diff cannot be combined with --json.
    out.length = 0;
    expect(await main([...command, '--json'], commandContext as never)).toBe(0);
    expect(JSON.parse(out.join(''))).toEqual(action === 'integration-check' ? expectedCheck : expectedPatch);
  }
});
