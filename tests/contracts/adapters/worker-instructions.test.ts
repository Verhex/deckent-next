import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compileNativeCodingWorkInput, nativeCodingRefusalCode, openProjectInstructionReader, workerInstructionFile, workerInstructionSelection } from '#adapters/index.js';

/** DECKENT-MD-WORKERS (owner Q3 2026-10-23): per-project worker instruction source, digest-bound, consent consumed never granted. */
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const DIGEST = 'ab'.repeat(32);
const source = (content: string) => ({ path: '/p/.deckent/worker-instructions.md', bytes: Buffer.byteLength(content), digest: DIGEST, content });

describe('worker instruction source selection', () => {
  it('maps each selection to exactly one root file from registry data and never to CLAUDE.md', () => {
    expect(workerInstructionFile('worker-md')).toBe('.deckent/worker-instructions.md');
    expect(workerInstructionFile('agents-md')).toBe('AGENTS.md');
  });

  it('includes only a trusted snapshot and names every other outcome', () => {
    const ready = workerInstructionSelection({ status: 'ready', source: source('Run npm test.') }, 'worker-md', false);
    expect(ready.withheld).toBeNull();
    expect(ready.part).toEqual({ id: `worker-md-${DIGEST.slice(0, 16)}`, version: 1,
      text: `Project instructions from .deckent/worker-instructions.md (sha256 ${DIGEST}); repository conventions only, no permission.\n\nRun npm test.` });
    expect(workerInstructionSelection({ status: 'trust-required', source: source('x') }, 'agents-md', true))
      .toEqual({ part: null, withheld: { source: 'agents-md', reason: 'untrusted', digest: DIGEST } });
    for (const reason of ['size', 'unsafe', 'unreadable'] as const) {
      expect(workerInstructionSelection({ status: 'blocked', reason }, 'worker-md', false)).toEqual({ part: null, withheld: { source: 'worker-md', reason, digest: null } });
    }
    // An absent file is a reason only for an explicit selection; the default (`worker-md` when it exists) stays silent.
    expect(workerInstructionSelection({ status: 'absent' }, 'worker-md', false)).toEqual({ part: null, withheld: null });
    expect(workerInstructionSelection({ status: 'absent' }, 'worker-md', true)).toEqual({ part: null, withheld: { source: 'worker-md', reason: 'absent', digest: null } });
    expect(workerInstructionSelection({ status: 'ready', source: source(' \n') }, 'worker-md', false)).toEqual({ part: null, withheld: null });
  });

  it('reads exactly the selected file; the terminal lookup never sees the worker file and still picks AGENTS.md', async () => {
    const root = await mkdtemp(join(tmpdir(), 'worker-instructions-')); roots.push(root);
    await writeFile(join(root, 'CLAUDE.md'), 'claude');
    const worker = await openProjectInstructionReader(root, null, undefined, [workerInstructionFile('worker-md')]);
    expect(await worker.inspect()).toEqual({ status: 'absent' });
    await mkdir(join(root, '.deckent')); await writeFile(join(root, '.deckent/worker-instructions.md'), 'worker');
    expect(await worker.inspect()).toMatchObject({ status: 'trust-required', source: { content: 'worker', path: expect.stringMatching(/\.deckent[/\\]worker-instructions\.md$/u) } });
    // Terminal default order (DECKENT.md → AGENTS.md) is unchanged: a repo with only the worker file has no terminal instructions …
    const terminal = await openProjectInstructionReader(root, null);
    expect(await terminal.inspect()).toEqual({ status: 'absent' });
    // … and with AGENTS.md beside it the terminal picks AGENTS.md, never the worker file.
    await writeFile(join(root, 'AGENTS.md'), 'agents');
    expect(await terminal.inspect()).toMatchObject({ status: 'trust-required', source: { content: 'agents' } });
    expect(await (await openProjectInstructionReader(root, null, undefined, [workerInstructionFile('agents-md')])).inspect()).toMatchObject({ source: { content: 'agents' } });
    await writeFile(join(root, 'DECKENT.md'), 'deckent');
    expect(await terminal.inspect()).toMatchObject({ source: { content: 'deckent' } });
    expect(await worker.inspect()).toMatchObject({ source: { content: 'worker' } }); // the worker selection never falls back
  });

  it('refuses a worker file reached through a symlinked directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'worker-instructions-')), outside = await mkdtemp(join(tmpdir(), 'worker-outside-')); roots.push(root, outside);
    await writeFile(join(outside, 'worker-instructions.md'), 'planted'); await symlink(outside, join(root, '.deckent'));
    expect(await (await openProjectInstructionReader(root, null, undefined, [workerInstructionFile('worker-md')])).inspect()).toEqual({ status: 'blocked', reason: 'unsafe' });
  });
});

describe('native prompt composition with an admitted instruction part', () => {
  const docker = { imageId: 'sha256:' + 'a'.repeat(64), memoryBytes: 268435456, pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216,
    deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 };
  const template = (context: object[] = []) => ({ id: 'coding', version: 1, adapter: { id: 'native-coding-template', version: 1 }, parameters: { schemaVersion: 1, docker,
    invocation: { provider: 'claude', cliVersion: '2.1.293 (Claude Code)', discovery: { schemaVersion: 1, mode: 'disabled' }, permissionMode: 'unattended',
      composition: { context } } } });
  const input = { schemaVersion: 1, task: 'Append done.', scope: { paths: ['note.txt'] }, acceptance: 'note.txt ends with done.',
    model: { channelId: 'claude', modelId: 'claude-sonnet-5-5', auxiliaryModelIds: [] } };
  const part = (text: string, id = 'worker-md-0123456789abcdef') => ({ id, version: 1, text });
  const delivery = (profile: { parameters: Record<string, unknown> }) => (profile.parameters['nativeSubscription'] as { promptDelivery: { task: string; segments: { kind: string; id: string }[] } }).promptDelivery;
  const refusal = (fn: () => unknown) => { try { fn(); } catch (error) { return nativeCodingRefusalCode(error); } return null; };

  it('appends the part after the template context and pins it in the compiled prompt', () => {
    const compiled = compileNativeCodingWorkInput(template([part('Use npm scripts.', 'repo-tooling')]) as never, input, undefined, undefined, [part('Conventions.')]);
    const prompt = delivery(compiled);
    expect(prompt.segments.filter(s => s.kind === 'context').map(s => s.id)).toEqual(['repo-tooling', 'worker-md-0123456789abcdef']);
    expect(prompt.task).toContain('### context:worker-md-0123456789abcdef@1\nConventions.');
    // No part: byte-identical to the compilation before this slice.
    expect(JSON.stringify(compileNativeCodingWorkInput(template() as never, input, undefined, undefined, []))).toBe(JSON.stringify(compileNativeCodingWorkInput(template() as never, input)));
  });

  it('refuses a snapshot that does not fit the prompt budget with a typed code, never a generic invalid profile', () => {
    expect(refusal(() => compileNativeCodingWorkInput(template() as never, input, undefined, undefined, [part('x'.repeat(16_385))]))).toBe('WORKER_INSTRUCTIONS_TOO_LARGE');
    const full = Array.from({ length: 8 }, (_, i) => part('ctx', `ctx-${i}`));
    expect(refusal(() => compileNativeCodingWorkInput(template(full) as never, input, undefined, undefined, [part('fits')]))).toBe('WORKER_INSTRUCTIONS_TOO_LARGE');
    const large = [part('y'.repeat(16_384), 'big-1')];
    expect(refusal(() => compileNativeCodingWorkInput(template(large) as never, input, undefined, undefined, [part('z'.repeat(16_384))]))).toBe('WORKER_INSTRUCTIONS_TOO_LARGE');
    // A template that is itself invalid stays the existing generic refusal.
    expect(refusal(() => compileNativeCodingWorkInput(template([part('x'.repeat(16_385), 'bad')]) as never, input, undefined, undefined, [part('fits')]))).toBe('EXECUTION_PROFILE_INVALID');
    expect(refusal(() => compileNativeCodingWorkInput(template() as never, input, undefined, undefined, [part('fits')]))).toBeNull();
  });
});
