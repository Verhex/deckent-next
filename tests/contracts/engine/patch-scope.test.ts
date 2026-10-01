import { describe, expect, it, vi } from 'vitest';
import { assertPatchScope, classifyPatchScope, patchDigest, patchExclusions, PATCH_SCOPE_ERROR_PATHS, WorkspaceIntegrationApplication,
  WorkspacePatchApplication, WorkspacePatchError, type PatchScopeMode, type WorkspacePatch } from '#engine/index.js';
import { createGlobMatcher, WORK_TARGET_SETTINGS } from '#platform/index.js';
import { createGlobMatcher as adapterMatcher } from '#adapters/core/workspace-read/index.js';

/** K6 = A (owner 2026-09-30): patch paths classified against the task's declared scope; warn reports, enforce refuses before any write. */
const file = (text: string, mode: '100644' | '100755' = '100644') => ({ mode, text, digest: patchDigest(text) });
const change = (path: string, before: string | null, after: string | null, mode?: '100755') =>
  ({ path, before: before === null ? null : file(before), after: after === null ? null : file(after, mode) });
const changes = (...paths: string[]) => ({ changes: paths.map(path => change(path, null, 'x\n')) });
const classify = (declared: readonly string[] | null, paths: readonly string[], mode: PatchScopeMode = 'warn') => classifyPatchScope(changes(...paths), declared, mode);

describe('patch scope classification (one deny grammar, exact full-path match)', () => {
  it('switch lives on the work target: optional warn|enforce, anything else refused (strict)', () => {
    const settings = (scope?: unknown) => WORK_TARGET_SETTINGS.safeParse({ schemaVersion: 1, targets: [{ id: 'n1', kind: 'git', path: '/t', baseRef: 'refs/heads/main', ...(scope === undefined ? {} : { scope }) }] }).success;
    expect([settings(), settings({ mode: 'warn' }), settings({ mode: 'enforce' })]).toEqual([true, true, true]);
    expect([settings({ mode: 'block' }), settings({}), settings({ mode: 'enforce', bypass: true }), settings('enforce')]).toEqual([false, false, false, false]);
  });
  it('uses the platform matcher the workspace deny language uses (moved, not copied)', () => {
    expect(adapterMatcher).toBe(createGlobMatcher);
  });
  it.each([
    // [declared, path, inScope]
    [['note.txt'], 'note.txt', true],
    [['note.txt'], 'a/note.txt', false],
    [['src/notes/**'], 'src/notes/a.ts', true],
    [['src/notes/**'], 'src/notes/deep/er/a.ts', true],
    [['src/notes/**'], 'src/notes', false],
    [['src/notes/**'], 'src/notesx/a.ts', false],
    [['src/notes'], 'src/notes/a.ts', false], // a literal is one file; a directory is written dir/**
    [['src/*.ts'], 'src/a.ts', true],
    [['src/*.ts'], 'src/x/a.ts', false], // `*` never crosses a segment
    [['src/**/*.test.ts'], 'src/a.test.ts', true], // `**/` is zero or more whole directories
    [['src/**/*.test.ts'], 'src/x/y/a.test.ts', true],
    [['**/README.md'], 'README.md', true],
    [['**/README.md'], 'docs/x/README.md', true],
    [['file?.txt'], 'file1.txt', true],
    [['file?.txt'], 'file/.txt', false],
    [['dir[1]/a.txt'], 'dir[1]/a.txt', true], // brackets are literal in this grammar
    [['dir[1]/a.txt'], 'dir1/a.txt', false],
    [['{a,b}.txt'], 'a.txt', false],
    [['.github/**'], '.github/workflows/ci.yml', true],
    [['*.md'], '.hidden.md', true], // no dot-file special case
  ])('%j vs %s -> in scope %s', (declared, path, inScope) => {
    expect(classify(declared, [path]).status).toBe(inScope ? 'in-scope' : 'out-of-scope');
  });
  it('classifies every changed path: rename across the boundary, out-of-scope deletion and mode-only change', () => {
    const patch = { changes: [
      change('docs/old.md', 'moved\n', null), // rename source (outside)
      change('src/new.md', null, 'moved\n'), // rename target (inside)
      change('src/kept.sh', 'echo\n', 'echo\n', '100755'), // mode only, inside
      change('tools/gone.txt', 'bye\n', null), // deletion outside
      change('tools/run.sh', 'echo\n', 'echo\n', '100755'), // mode only, outside
    ] };
    const scope = classifyPatchScope(patch, ['src/**'], 'warn');
    expect(scope).toEqual({ schemaVersion: 1, matcher: 1, mode: 'warn', status: 'out-of-scope', declared: ['src/**'],
      outOfScope: ['docs/old.md', 'tools/gone.txt', 'tools/run.sh'] });
    // A rename whose both sides are inside stays in scope.
    expect(classifyPatchScope({ changes: [change('src/a.md', 'x\n', null), change('src/b/a.md', null, 'x\n')] }, ['src/**'], 'warn').status).toBe('in-scope');
  });
  it('makes a missing work input explicit (unscoped), never in scope, and an empty patch in scope', () => {
    expect(classify(null, ['anything.txt'])).toEqual({ schemaVersion: 1, matcher: 1, mode: 'warn', status: 'unscoped' });
    expect(classify(['src/**'], []).status).toBe('in-scope');
  });
  it('warn never refuses; enforce refuses out-of-scope with bounded paths and undeclared scope with its own code', () => {
    for (const scope of [classify(null, ['a']), classify(['b'], ['a']), classify(['a'], ['a']), classify(['a'], ['a'], 'enforce')]) expect(() => assertPatchScope(scope)).not.toThrow();
    const many = Array.from({ length: PATCH_SCOPE_ERROR_PATHS + 4 }, (_, i) => `out/${String(i).padStart(2, '0')}.txt`);
    const refusal = (() => { try { assertPatchScope(classify(['in/**'], ['in/a.txt', ...many], 'enforce')); } catch (error) { return error; } })() as WorkspacePatchError;
    expect(refusal).toBeInstanceOf(WorkspacePatchError);
    expect(refusal.code).toBe('PATCH_SCOPE_VIOLATION');
    expect(refusal.params).toEqual({ count: many.length, paths: many.slice(0, PATCH_SCOPE_ERROR_PATHS).join(', '), omitted: 4 });
    expect(() => assertPatchScope(classify(null, ['a'], 'enforce'))).toThrow(expect.objectContaining({ code: 'PATCH_SCOPE_UNDECLARED' }));
  });
});

describe('patch application and integration gate with the Run-bound task scope', () => {
  const identity = { runId: 'r', taskId: 't', attemptId: 'a', scopeId: 's', layoutRevision: 'l', generation: 1 };
  const principal = { id: 'p', issuer: 'i', subject: 'u', assurance: 'os-user' as const, scopeIds: ['s'] };
  const patch: WorkspacePatch = { schemaVersion: 1, kind: 'workspace-patch', identity, source: { schemaVersion: 1, adapter: { id: 'git', version: 1 }, sourceFingerprint: 'f'.repeat(64) },
    baseCommit: 'b'.repeat(40), snapshotDigest: 'd'.repeat(64), exclusions: { ...patchExclusions, excludedSegments: [...patchExclusions.excludedSegments], excludedPrefixes: [...patchExclusions.excludedPrefixes] },
    changes: [change('notes/in.txt', null, 'in\n'), change('stray.log', null, 'debug\n')] };
  function harness(mode: PatchScopeMode, workInput: object | undefined) {
    const bytes = new Map<string, Uint8Array>(); let bound: { schemaVersion: 1; scopeId: string; digest: string; byteLength: number } | undefined;
    const artifacts = { async put(scopeId: string, value: Uint8Array) { const digest = patchDigest(value); bytes.set(digest, value); return { schemaVersion: 1, scopeId, digest, byteLength: value.length }; },
      async read(_scope: string, receipt: { digest: string }) { return bytes.get(receipt.digest)!; } };
    const record = () => ({ request: { identity }, owner: 'o', terminal: { handle: 'h' }, ...(bound ? { patch: bound } : {}) });
    const loadBoundTask = vi.fn(async () => ({ id: 't', kind: 'coding', dependencies: [], acceptanceCriteria: ['exit'], ...(workInput ? { workInput } : {}) }));
    const store = { async loadBoundDispatch() { return record(); }, loadBoundTask,
      async retainDispatchPatch(_claim: unknown, receipt: typeof bound) { bound = receipt; return record(); } };
    const verifier = { async verify() { return principal; } }, authorization = { async authorizeIdentity() {} };
    const patches = new WorkspacePatchApplication(store as never, artifacts as never, verifier, authorization, 65536, mode);
    const claimIntegration = vi.fn(), targetPrepare = vi.fn();
    const target = { async observe() { return { digest: 'e'.repeat(64), source: 'git', head: 'b'.repeat(40) }; }, prepare: targetPrepare, async verify() {} };
    const integration = new WorkspaceIntegrationApplication(patches, target as never, verifier, authorization, artifacts as never, 65536);
    return { patches, integration, claimIntegration, targetPrepare, loadBoundTask, prepare: () => patches.prepare(identity, { async capture() { return patch; } }, store as never) };
  }
  const input = { schemaVersion: 1, task: 'Edit notes.', scope: { paths: ['notes/**'] }, acceptance: 'Done.', model: { channelId: 'c', modelId: 'm', auxiliaryModelIds: [] } };
  it('warn: the patch is prepared, previewed and checked with a visible out-of-scope classification; integration proceeds', async () => {
    const h = harness('warn', input);
    const prepared = await h.prepare();
    expect(prepared.scope).toEqual({ schemaVersion: 1, matcher: 1, mode: 'warn', status: 'out-of-scope', declared: ['notes/**'], outOfScope: ['stray.log'] });
    expect((await h.patches.preview(identity)).scope).toEqual(prepared.scope);
    const checked = await h.integration.check(identity);
    expect(checked.scope).toEqual(prepared.scope);
    h.targetPrepare.mockRejectedValue(new Error('candidate-write-reached'));
    await expect(h.integration.prepare({ schemaVersion: 1, commandId: 'c', identity, proposal: checked.proposal }, { claimIntegration: h.claimIntegration.mockResolvedValue({ acquired: true, record: {} }), finishIntegration: vi.fn() }))
      .rejects.toThrow('candidate-write-reached');
    expect(h.claimIntegration).toHaveBeenCalledTimes(1);
  });
  it.each([['out-of-scope', input, 'PATCH_SCOPE_VIOLATION'], ['unscoped', undefined, 'PATCH_SCOPE_UNDECLARED']] as const)(
    'enforce (%s): the patch is still prepared and visible; integration prepare refuses before the intent claim or any candidate write', async (status, workInput, code) => {
      const h = harness('enforce', workInput);
      const prepared = await h.prepare();
      expect(prepared.scope).toMatchObject({ mode: 'enforce', status });
      const checked = await h.integration.check(identity); // read-only check reports, never refuses
      expect(checked.scope.status).toBe(status);
      await expect(h.integration.prepare({ schemaVersion: 1, commandId: 'c', identity, proposal: checked.proposal }, { claimIntegration: h.claimIntegration, finishIntegration: vi.fn() }))
        .rejects.toMatchObject({ code });
      expect(h.claimIntegration).not.toHaveBeenCalled(); expect(h.targetPrepare).not.toHaveBeenCalled();
    });
  it('enforce with every changed path inside the declared scope integrates', async () => {
    const h = harness('enforce', { ...input, scope: { paths: ['notes/**', 'stray.log'] } });
    expect((await h.prepare()).scope.status).toBe('in-scope');
    const checked = await h.integration.check(identity);
    h.claimIntegration.mockResolvedValue({ acquired: true, record: {} }); h.targetPrepare.mockRejectedValue(new Error('candidate-write-reached'));
    await expect(h.integration.prepare({ schemaVersion: 1, commandId: 'c', identity, proposal: checked.proposal }, { claimIntegration: h.claimIntegration, finishIntegration: vi.fn() }))
      .rejects.toThrow('candidate-write-reached');
  });
  it('reads the declared scope from the exact Run binding of the attempt', async () => {
    const h = harness('warn', input); await h.prepare();
    expect(h.loadBoundTask).toHaveBeenCalledWith(identity);
  });
});
