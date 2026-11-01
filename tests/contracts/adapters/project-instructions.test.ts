import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openProjectInstructionReader, previewProjectInstructions, PROJECT_INSTRUCTION_REGISTRY, isWriteApprovalFloored, legacyProjectInstructions } from '#adapters/index.js';
import { instructionImports } from '#engine/index.js';
import { snapshotKnownSecrets } from '#platform/index.js';
import { projectSkeleton } from '#surfaces/core/project-instructions/index.js';
const roots: string[] = [];
// Native Windows has no POSIX owner or mode to verify a private trust directory: the reader refuses one there, and the product keeps consent
// in the session instead (configured composition passes no directory). Tests that need no persisted consent open the reader that way.
const persistedTrust = process.platform !== 'win32';
async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), 'instruction-')); roots.push(folder);
  const root = join(folder, 'project'), trust = join(folder, 'trust');
  await mkdir(root); await mkdir(trust, { mode: 0o700 });
  if (!persistedTrust) await expect(openProjectInstructionReader(root, trust)).rejects.toThrow('unsafe');
  return { root, trust, reader: await openProjectInstructionReader(root, persistedTrust ? trust : null) };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe('workspace-root project instructions', () => {
  it('selects AGENTS then CLAUDE then legacy, resolves relative imports once and keeps workers literal', async () => {
    expect(instructionImports('mail@host `@literal`\n```md\n@ignored\n```\nsee @docs/x.md @Design\\ Docs/rules.md')).toEqual(['docs/x.md', 'Design Docs/rules.md']);
    const f = await fixture(); await mkdir(join(f.root, 'docs'));
    await writeFile(join(f.root, 'DECKENT.md'), 'legacy');
    expect(await f.reader.inspect()).toMatchObject({ source: { content: 'legacy' } });
    await writeFile(join(f.root, 'CLAUDE.md'), 'claude');
    expect(await f.reader.inspect()).toMatchObject({ source: { content: 'claude' } });
    await writeFile(join(f.root, 'AGENTS.md'), 'primary @docs/x.md @docs/x.md');
    await writeFile(join(f.root, 'docs/x.md'), 'nested @./y.md'); await writeFile(join(f.root, 'docs/y.md'), 'ONCE');
    await writeFile(join(f.root, 'CLAUDE.md'), '@AGENTS.md');
    const view = await f.reader.inspect();
    expect(view).toMatchObject({ status: 'trust-required', source: { path: join(await realpath(f.root), 'AGENTS.md'), content: 'primary @docs/x.md @docs/x.md\nnested @./y.md\nONCE' } });
    if (!('source' in view)) throw new Error('source');
    await f.reader.trust(view.source.digest);
    const worker = await openProjectInstructionReader(f.root, persistedTrust ? f.trust : null, undefined, ['AGENTS.md']);
    expect(await worker.inspect()).toMatchObject({ status: 'trust-required', source: { content: 'primary @docs/x.md @docs/x.md' } });
    await writeFile(join(f.root, 'docs/y.md'), 'CHANGED');
    expect(await f.reader.inspect()).toMatchObject({ status: 'trust-required' });
    await writeFile(join(f.root, 'docs/y.md'), '@../AGENTS.md');
    expect(await f.reader.inspect()).toEqual({ status: 'blocked', reason: 'unsafe' });
    await writeFile(join(f.root, 'AGENTS.md'), '@missing.md');
    expect(await f.reader.inspect()).toEqual({ status: 'blocked', reason: 'unreadable' });
    await writeFile(join(f.root, 'AGENTS.md'), '@/outside.md');
    expect(await f.reader.inspect()).toEqual({ status: 'blocked', reason: 'unsafe' });
  });
  it('bounds individual and total bytes and rejects depth six, never falling back from invalid AGENTS', async () => {
    const f = await fixture(); await writeFile(join(f.root, 'CLAUDE.md'), 'fallback');
    await writeFile(join(f.root, 'AGENTS.md'), 'a'.repeat(PROJECT_INSTRUCTION_REGISTRY.maxBytes));
    expect(await f.reader.inspect()).toMatchObject({ status: 'trust-required' });
    await writeFile(join(f.root, 'AGENTS.md'), 'ş'.repeat(PROJECT_INSTRUCTION_REGISTRY.maxBytes));
    expect(await f.reader.inspect()).toEqual({ status: 'blocked', reason: 'size' });
    await writeFile(join(f.root, 'AGENTS.md'), '@large.md');
    await writeFile(join(f.root, 'large.md'), 'a'.repeat(PROJECT_INSTRUCTION_REGISTRY.maxBytes));
    expect(await f.reader.inspect()).toEqual({ status: 'blocked', reason: 'size' });
    const directive = '@large.md @large.md';
    await writeFile(join(f.root, 'AGENTS.md'), directive);
    await writeFile(join(f.root, 'large.md'), 'a'.repeat(PROJECT_INSTRUCTION_REGISTRY.maxBytes - Buffer.byteLength(directive) - 1));
    expect(await f.reader.inspect()).toMatchObject({ status: 'trust-required' });
    await writeFile(join(f.root, 'AGENTS.md'), '@1.md');
    for (let n = 1; n <= 5; n++) await writeFile(join(f.root, `${n}.md`), n < 5 ? `@${n + 1}.md` : 'FIVE');
    expect(await f.reader.inspect()).toMatchObject({ status: 'trust-required', source: { content: expect.stringContaining('FIVE') } });
    await writeFile(join(f.root, '5.md'), '@6.md'); await writeFile(join(f.root, '6.md'), 'SIX');
    expect(await f.reader.inspect()).toEqual({ status: 'blocked', reason: 'unsafe' });

  });
  it('masks known values and credential shapes before even the trust preview', async () => {
    const f = await fixture(), secret = 'opaque-private-credential';
    const reader = await openProjectInstructionReader(f.root, persistedTrust ? f.trust : null, snapshotKnownSecrets([{ name: 'DECKENT_TEST', value: secret }]));
    await writeFile(join(f.root, 'DECKENT.md'), `Use ${secret}; password=very-secret-password`);
    const view = await reader.inspect();
    expect(JSON.stringify(view)).not.toContain(secret); expect(JSON.stringify(view)).not.toContain('very-secret-password');
    expect(view).toMatchObject({ status: 'trust-required', source: { bytes: Buffer.byteLength(`Use ${secret}; password=very-secret-password`) } });
    await writeFile(join(f.root, 'AGENTS.md'), '@secret.md'); await writeFile(join(f.root, 'secret.md'), secret);
    const imported = await reader.inspect();
    expect(imported).toMatchObject({ status: 'trust-required' }); expect(JSON.stringify(imported)).not.toContain(secret);
  });
  it.skipIf(process.platform === 'win32')('[unsupported on Windows: project instruction trust cache] remembers consent by digest, asks again on change, and refuses stale digest acceptance', async () => {
    const f = await fixture(); await writeFile(join(f.root, 'DECKENT.md'), 'one');
    const first = await f.reader.inspect(); if (!('source' in first)) throw new Error('source');
    expect(await f.reader.trust(first.source.digest)).toMatchObject({ status: 'ready' });
    expect(await (await openProjectInstructionReader(f.root, f.trust)).inspect()).toMatchObject({ status: 'ready' });
    await writeFile(join(f.root, 'DECKENT.md'), 'two');
    expect(await f.reader.trust(first.source.digest)).toMatchObject({ status: 'trust-required', source: { content: 'two' } });
    expect(await f.reader.inspect()).toMatchObject({ status: 'trust-required' });
  });
  it.skipIf(process.platform === 'win32')('[unsupported on Windows: project instruction trust cache] AYSE-19: a decline is remembered for exactly this content, grants nothing, and a changed file asks again', async () => {
    const f = await fixture(); await writeFile(join(f.root, 'DECKENT.md'), 'one');
    const first = await f.reader.inspect(); if (!('source' in first)) throw new Error('source');
    await f.reader.decline(first.source.digest);
    const again = await openProjectInstructionReader(f.root, f.trust);
    expect(await again.declined(first.source.digest)).toBe(true); expect(await again.inspect()).toMatchObject({ status: 'trust-required' });
    await writeFile(join(f.root, 'DECKENT.md'), 'two');
    const changed = await again.inspect(); if (!('source' in changed)) throw new Error('source');
    expect(await again.declined(changed.source.digest)).toBe(false);
  });
  it.skipIf(process.platform === 'win32')('[unsupported on Windows: project instruction trust cache] a cloned workspace with identical instructions cannot inherit consent or use its own trust record', async () => {
    const f = await fixture(); await writeFile(join(f.root, 'DECKENT.md'), 'same content');
    const first = await f.reader.inspect(); if (!('source' in first)) throw new Error('source'); await f.reader.trust(first.source.digest);
    const clone = join(f.root, 'clone'); await mkdir(clone); await writeFile(join(clone, 'DECKENT.md'), 'same content');
    expect(await (await openProjectInstructionReader(clone, f.trust)).inspect()).toMatchObject({ status: 'trust-required' });
    const local = join(clone, 'trust'); await mkdir(local, { mode: 0o700 });
    await expect(openProjectInstructionReader(clone, local)).rejects.toThrow('unsafe');
  });
  it('rejects a symlink primary without falling back and protects DECKENT.md in the write floor', async () => {
    const f = await fixture(); await writeFile(join(f.root, 'CLAUDE.md'), 'fallback');
    await symlink(join(f.root, 'CLAUDE.md'), join(f.root, 'AGENTS.md'));
    expect(await f.reader.inspect()).toEqual({ status: 'blocked', reason: 'unsafe' });
    expect(isWriteApprovalFloored('DECKENT.md')).toBe(true);
    await rm(join(f.root, 'AGENTS.md')); await writeFile(join(f.root, 'AGENTS.md'), '@linked.md');
    await symlink(join(f.root, 'CLAUDE.md'), join(f.root, 'linked.md'));
    expect(await f.reader.inspect()).toEqual({ status: 'blocked', reason: 'unsafe' });
    await rm(join(f.root, 'linked.md')); await mkdir(join(f.root, 'docs'));
    await writeFile(join(f.root, 'docs/x.md'), 'hidden'); await symlink(join(f.root, 'docs'), join(f.root, 'linked'));
    await writeFile(join(f.root, 'AGENTS.md'), '@linked/x.md');
    expect(await f.reader.inspect()).toEqual({ status: 'blocked', reason: 'unsafe' });
  });
  it('without a supported private cache remembers consent only in the current session, by exact digest', async () => {
    const f = await fixture(); await writeFile(join(f.root, 'DECKENT.md'), 'session context');
    const reader = await openProjectInstructionReader(f.root, null), first = await reader.inspect();
    if (!('source' in first)) throw new Error('source');
    await reader.trust(first.source.digest); expect(await reader.inspect()).toMatchObject({ status: 'ready' });
    expect(await (await openProjectInstructionReader(f.root, null)).inspect()).toMatchObject({ status: 'trust-required' });
    await writeFile(join(f.root, 'DECKENT.md'), 'changed'); expect(await reader.inspect()).toMatchObject({ status: 'trust-required' });
    await writeFile(join(f.root, 'AGENTS.md'), '@../outside.md');
    await writeFile(join(f.root, '../outside.md'), 'EXTERNAL');
    const external = await f.reader.inspect();
    expect(external).toMatchObject({ status: 'trust-required', source: { external: true, content: '@../outside.md\nEXTERNAL' } });
    if (!('source' in external)) throw new Error('source');
    expect(await f.reader.trust(external.source.digest)).toMatchObject({ status: 'ready' });
    expect(await f.reader.inspect()).toMatchObject({ status: 'ready' });
    expect(await (await openProjectInstructionReader(f.root, persistedTrust ? f.trust : null)).inspect()).toMatchObject({ status: 'trust-required' });
    await writeFile(join(f.root, '../outside.md'), 'MODIFIED');
    expect(await f.reader.trust(external.source.digest)).toMatchObject({ status: 'trust-required' });

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
  it('preserves both standard files byte for byte and never proposes a bridge or DECKENT write', async () => {
    const f = await fixture();
    await writeFile(join(f.root, 'DECKENT.md'), 'legacy'); await writeFile(join(f.root, 'CLAUDE.md'), 'old content\r\n');
    await writeFile(join(f.root, 'AGENTS.md'), 'old agent');
    expect(await previewProjectInstructions(f.root, [], projectSkeleton('en'))).toMatchObject({ changes: [], bridges: [] });
    expect(await readFile(join(f.root, 'CLAUDE.md'), 'utf8')).toBe('old content\r\n');
    expect(await readFile(join(f.root, 'AGENTS.md'), 'utf8')).toBe('old agent');
    await expect(previewProjectInstructions(f.root, ['claude-code'], projectSkeleton('en'))).rejects.toThrow('unsafe');
  });
  it('creates only an AGENTS preview on legacy installs; an existing CLAUDE needs no generated file', async () => {
    const f = await fixture(); await writeFile(join(f.root, 'DECKENT.md'), 'legacy');
    expect(await legacyProjectInstructions(f.root)).toBe(true);
    expect((await previewProjectInstructions(f.root, [], projectSkeleton('tr'))).changes.map(change => change.path)).toEqual(['AGENTS.md']);
    await writeFile(join(f.root, 'CLAUDE.md'), 'existing');
    expect(await legacyProjectInstructions(f.root)).toBe(false);
    expect((await previewProjectInstructions(f.root, [], projectSkeleton('tr'))).changes).toEqual([]);
  });
});

describe.skipIf(process.platform !== 'linux')('F3: forgetting this folder\'s legacy trust validates the trust root first', () => {
  it('a trust store reached through a link is refused and the snapshot behind it keeps its bytes; the real store forgets only this folder', async () => {
    const { forgetFolderLegacyTrust } = await import('#adapters/index.js'), { chmod, rm: remove } = await import('node:fs/promises');
    const base = await realpath(await mkdtemp(join(tmpdir(), 'deckent-forget-trust-'))); roots.push(base);
    const project = join(base, 'project'), store = join(base, 'store'), linked = join(base, 'linked');
    await mkdir(project); await mkdir(store); await chmod(store, 0o700); await writeFile(join(project, 'DECKENT.md'), '# rules\n');
    const reader = await openProjectInstructionReader(project, store), view = await reader.inspect();
    if (view.status !== 'trust-required') throw new Error(view.status); await reader.trust(view.source.digest);
    // A store from an earlier release: its folder record is in the legacy snapshot.
    await remove(join(store, PROJECT_INSTRUCTION_REGISTRY.legacyTrust.file)); await openProjectInstructionReader(project, store);
    const snapshot = await readFile(join(store, PROJECT_INSTRUCTION_REGISTRY.legacyTrust.file));
    await symlink(store, linked);
    await expect(forgetFolderLegacyTrust(project, linked)).rejects.toThrow('unsafe');
    expect((await readFile(join(store, PROJECT_INSTRUCTION_REGISTRY.legacyTrust.file))).equals(snapshot)).toBe(true);
    await forgetFolderLegacyTrust(project, store);
    expect((await readFile(join(store, PROJECT_INSTRUCTION_REGISTRY.legacyTrust.file))).length).toBeLessThan(snapshot.length);
  });
});

it.skipIf(process.platform !== 'linux')('F3: a trust parent swapped after pinning cannot redirect lock/temp/publication, and a foreign final leaf is never replaced', async () => {
  const { forgetFolderLegacyTrust } = await import('#adapters/index.js'), { open, rename, chmod, unlink } = await import('node:fs/promises');
  const base = await realpath(await mkdtemp(join(tmpdir(), 'deckent-trust-race-'))); roots.push(base);
  const project = join(base, 'project'), store = join(base, 'store'), outside = join(base, 'outside'), moved = store + '-moved';
  for (const dir of [project, store, outside]) { await mkdir(dir); await chmod(dir, 0o700); }
  await writeFile(join(project, 'DECKENT.md'), '# rules');
  const reader = await openProjectInstructionReader(project, store), view = await reader.inspect();
  if (view.status !== 'trust-required') throw new Error(view.status); await reader.trust(view.source.digest);
  const name = PROJECT_INSTRUCTION_REGISTRY.legacyTrust.file; await unlink(join(store, name)); await openProjectInstructionReader(project, store);
  const snapshot = await readFile(join(store, name)); await writeFile(join(outside, name), snapshot, { mode: 0o600 });
  const probe = await open(join(base, 'probe'), 'w'), proto = Object.getPrototypeOf(probe) as { stat(): ReturnType<typeof probe.stat>; sync(): Promise<void> }; await probe.close();
  const stat = proto.stat; let swapped = false;
  const spy = vi.spyOn(proto, 'stat').mockImplementation(async function (this: typeof probe) {
    const info = await stat.call(this);
    if (!swapped && info.isDirectory()) { swapped = true; await rename(store, moved); await symlink(outside, store); }
    return info;
  });
  try { await expect(forgetFolderLegacyTrust(project, store)).rejects.toThrow('unsafe'); } finally { spy.mockRestore(); }
  expect(swapped).toBe(true); expect((await readFile(join(outside, name))).equals(snapshot)).toBe(true);
  expect(await readdir(outside)).toEqual([name]); expect((await readFile(join(moved, name))).length).toBeLessThan(snapshot.length);
  await unlink(store); await rename(moved, store); await writeFile(join(store, name), snapshot, { mode: 0o600 });
  // Replace the final name during the new snapshot's sync (after its locked read): the publisher moves, verifies and restores it.
  const sync = proto.sync; let injected = false;
  const syncing = vi.spyOn(proto, 'sync').mockImplementation(async function (this: typeof probe) {
    const path = await (await import('node:fs/promises')).readlink(`/proc/self/fd/${this.fd}`);
    if (!injected && path.endsWith('.tmp')) { injected = true; await unlink(join(store, name)); await writeFile(join(store, name), 'PERSON DATA', { mode: 0o600 }); }
    return sync.call(this);
  });
  try { await expect(forgetFolderLegacyTrust(project, store)).rejects.toMatchObject({ reason: 'changed' }); } finally { syncing.mockRestore(); }
  expect(injected).toBe(true); expect(await readFile(join(store, name), 'utf8')).toBe('PERSON DATA');
  expect(await readdir(outside)).toEqual([name]);
});
