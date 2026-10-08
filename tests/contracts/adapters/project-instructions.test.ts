import { mkdir, mkdtemp, readFile, rm, symlink, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openProjectInstructionReader, previewProjectInstructions, PROJECT_INSTRUCTION_REGISTRY, isWriteApprovalFloored } from '#adapters/index.js';
import { snapshotKnownSecrets } from '#platform/index.js';
import { projectSkeleton } from '#surfaces/core/project-instructions/index.js';
const roots: string[] = [];
async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), 'instruction-')); roots.push(folder);
  const root = join(folder, 'project'), trust = join(folder, 'trust');
  await mkdir(root); await mkdir(trust, { mode: 0o700 });
  return { root, trust, reader: await openProjectInstructionReader(root, trust) };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe('workspace-root project instructions', () => {
  it('prefers DECKENT.md, falls back only on absence, and never loads CLAUDE.md or nested/parent instructions', async () => {
    const f = await fixture();
    await writeFile(join(f.root, 'CLAUDE.md'), 'wrong'); await mkdir(join(f.root, 'nested'));
    await writeFile(join(f.root, 'nested/DECKENT.md'), 'nested');
    expect(await f.reader.inspect()).toEqual({ status: 'absent' });
    await writeFile(join(f.root, 'AGENTS.md'), 'fallback');
    expect(await f.reader.inspect()).toMatchObject({ status: 'trust-required', source: { content: 'fallback' } });
    await writeFile(join(f.root, 'DECKENT.md'), 'primary');
    expect(await f.reader.inspect()).toMatchObject({ source: { path: join(f.root, 'DECKENT.md'), bytes: 7, content: 'primary' } });
    await writeFile(join(f.root, 'DECKENT.md'), '');
    expect(await f.reader.inspect()).toMatchObject({ source: { content: '', bytes: 0 } });
  });
  it('bounds reads in bytes including multibyte input and never falls back from an oversized primary', async () => {
    const f = await fixture(); await writeFile(join(f.root, 'AGENTS.md'), 'fallback');
    await writeFile(join(f.root, 'DECKENT.md'), 'a'.repeat(PROJECT_INSTRUCTION_REGISTRY.maxBytes));
    expect(await f.reader.inspect()).toMatchObject({ status: 'trust-required' });
    await writeFile(join(f.root, 'DECKENT.md'), 'ş'.repeat(PROJECT_INSTRUCTION_REGISTRY.maxBytes));
    expect(await f.reader.inspect()).toEqual({ status: 'blocked', reason: 'size' });
  });
  it('masks known values and credential shapes before even the trust preview', async () => {
    const f = await fixture(), secret = 'opaque-private-credential';
    const reader = await openProjectInstructionReader(f.root, f.trust, snapshotKnownSecrets([{ name: 'DECKENT_TEST', value: secret }]));
    await writeFile(join(f.root, 'DECKENT.md'), `Use ${secret}; password=very-secret-password`);
    const view = await reader.inspect();
    expect(JSON.stringify(view)).not.toContain(secret); expect(JSON.stringify(view)).not.toContain('very-secret-password');
    expect(view).toMatchObject({ status: 'trust-required', source: { bytes: Buffer.byteLength(`Use ${secret}; password=very-secret-password`) } });
  });
  it('remembers consent by digest, asks again on change, and refuses stale digest acceptance', async () => {
    const f = await fixture(); await writeFile(join(f.root, 'DECKENT.md'), 'one');
    const first = await f.reader.inspect(); if (!('source' in first)) throw new Error('source');
    expect(await f.reader.trust(first.source.digest)).toMatchObject({ status: 'ready' });
    expect(await (await openProjectInstructionReader(f.root, f.trust)).inspect()).toMatchObject({ status: 'ready' });
    await writeFile(join(f.root, 'DECKENT.md'), 'two');
    expect(await f.reader.trust(first.source.digest)).toMatchObject({ status: 'trust-required', source: { content: 'two' } });
    expect(await f.reader.inspect()).toMatchObject({ status: 'trust-required' });
  });
  it('a cloned workspace with identical instructions cannot inherit consent or use its own trust record', async () => {
    const f = await fixture(); await writeFile(join(f.root, 'DECKENT.md'), 'same content');
    const first = await f.reader.inspect(); if (!('source' in first)) throw new Error('source'); await f.reader.trust(first.source.digest);
    const clone = join(f.root, 'clone'); await mkdir(clone); await writeFile(join(clone, 'DECKENT.md'), 'same content');
    expect(await (await openProjectInstructionReader(clone, f.trust)).inspect()).toMatchObject({ status: 'trust-required' });
    const local = join(clone, 'trust'); await mkdir(local, { mode: 0o700 });
    await expect(openProjectInstructionReader(clone, local)).rejects.toThrow('unsafe');
  });
  it('rejects a symlink primary without falling back and protects DECKENT.md in the write floor', async () => {
    const f = await fixture(); await writeFile(join(f.root, 'AGENTS.md'), 'safe');
    await symlink(join(f.root, 'AGENTS.md'), join(f.root, 'DECKENT.md'));
    expect(await f.reader.inspect()).toEqual({ status: 'blocked', reason: 'unsafe' });
    expect(isWriteApprovalFloored('DECKENT.md')).toBe(true);
  });
  it('without a supported private cache remembers consent only in the current session, by exact digest', async () => {
    const f = await fixture(); await writeFile(join(f.root, 'DECKENT.md'), 'session context');
    const reader = await openProjectInstructionReader(f.root, null), first = await reader.inspect();
    if (!('source' in first)) throw new Error('source');
    await reader.trust(first.source.digest); expect(await reader.inspect()).toMatchObject({ status: 'ready' });
    expect(await (await openProjectInstructionReader(f.root, null)).inspect()).toMatchObject({ status: 'trust-required' });
    await writeFile(join(f.root, 'DECKENT.md'), 'changed'); expect(await reader.inspect()).toMatchObject({ status: 'trust-required' });
  });
});
describe('instruction init previews', () => {
  it('derives name and npm commands without running scripts, preview writes nothing or creates no bridges by default', async () => {
    const f = await fixture(); await writeFile(join(f.root, 'package.json'), JSON.stringify({ name: 'derived-name', scripts: { test: 'exit 1', build: 'do-not-execute', 'bad name': 'no' } }));
    const preview = await previewProjectInstructions(f.root, [], projectSkeleton('en'));
    expect(preview.changes).toHaveLength(1); expect(preview.changes[0]?.after).toContain('# derived-name');
    expect(preview.changes[0]?.after).toContain('npm run build'); expect(preview.changes[0]?.after).toContain('npm run test');
    expect(preview.changes[0]?.after).not.toContain('exit 1'); expect(await readdir(f.root)).toEqual(['package.json']);
  });
  it('selected bridges append exact lines preserving existing bytes; existing DECKENT.md is never overwritten', async () => {
    const f = await fixture(); await writeFile(join(f.root, 'DECKENT.md'), 'existing skeleton');
    await writeFile(join(f.root, 'CLAUDE.md'), 'old content\r\n'); await writeFile(join(f.root, 'AGENTS.md'), 'old agent');
    const preview = await previewProjectInstructions(f.root, ['claude-code', 'agents-md'], projectSkeleton('en'));
    expect(preview.changes.map(change => change.path)).toEqual(['CLAUDE.md', 'AGENTS.md']);
    expect(preview.changes[0]?.after).toBe('old content\r\n@DECKENT.md\n');
    expect(preview.changes[1]?.after).toBe('old agent\nRead DECKENT.md\n');
    expect(await readFile(join(f.root, 'CLAUDE.md'), 'utf8')).toBe('old content\r\n');
    await writeFile(join(f.root, 'CLAUDE.md'), preview.changes[0]!.after); await writeFile(join(f.root, 'AGENTS.md'), preview.changes[1]!.after);
    expect((await previewProjectInstructions(f.root, ['claude-code', 'agents-md'], projectSkeleton('en'))).changes).toEqual([]);
  });
  it('only explicit selection can propose creating missing bridges; detects existing host markers', async () => {
    const f = await fixture(); await mkdir(join(f.root, '.claude'));
    const initial = await previewProjectInstructions(f.root, [], projectSkeleton('tr'));
    expect(initial.bridges.find(row => row.id === 'claude-code')?.detected).toBe(true);
    expect(initial.changes.map(change => change.path)).toEqual(['DECKENT.md']);
    const selected = await previewProjectInstructions(f.root, ['agents-md'], projectSkeleton('tr'));
    expect(selected.changes.find(change => change.path === 'AGENTS.md')?.after).toBe('Read DECKENT.md\n');
  });
});
