import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { realpath, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeModeRuntimes, modeRuntime, rule } from '../support/agent-turn-modes.js';
import { measureTestShellHost } from '../../fixtures/shell-host.js';

const identity = vi.hoisted(() => ({ sourceCommonDir: undefined as string | undefined }));
vi.mock('#platform/index.js', async importOriginal => ({ ...await importOriginal<Record<string, unknown>>(), readBuildIdentity: () =>
  ({ sourceTreeSha256: 'a'.repeat(64), sourceCommit: null, sourceDirty: false, ...(identity.sourceCommonDir ? { sourceCommonDir: identity.sourceCommonDir } : {}) }) }));
afterEach(async () => { identity.sourceCommonDir = undefined; await closeModeRuntimes(); });
const grants = [rule('edit', 'agent-tool', ['edit_file'], 'allow'), rule('write', 'operation', ['workspace.file.write'], 'allow')];
const edit = { path: 'src/a.ts', old_string: 'a = 1', new_string: 'a = 2' };

const bwrapReady = (await measureTestShellHost()).bubblewrap.status === 'available';
const nativePeerAvailable = existsSync(new URL('../../../src/adapters/core/local-runtime-socket/native/build/Release/peer_credentials.node', import.meta.url));
console.info('self-source runtime native peer available:', nativePeerAvailable);
describe.skipIf(process.platform !== 'linux' || !nativePeerAvailable)('self-source floor from real service turn to sealed owner card', () => {
  for (const mode of ['standart', 'full-auto'] as const) {
    it(`${mode} derives own repository, names source/path/mode and refuses an unanswered source write`, async () => {
      const f = await modeRuntime({ grants, mode: { mode } });
      execFileSync('git', ['init', '-q'], { cwd: f.project });
      identity.sourceCommonDir = await realpath(join(f.project, '.git'));
      const result = await f.call('edit_file', edit);
      expect(result.card).toBe(true);
      const requested = result.events.find(event => event.kind === 'approval.requested');
      expect(requested).toMatchObject({ risk: 'edit-self-source', requiredAssurance: 'turn-bound', summary: expect.stringContaining('src/a.ts') });
      if (requested?.kind !== 'approval.requested') throw new Error('missing card');
      expect(requested.summary).toContain(mode);
      expect(requested.summary).toMatch(/Deckent.*source|Deckent.*kaynağı/u);
      expect(await readFile(join(f.project, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
    });
  }
  it('separate repository and old build identity leave an ordinary customer source edit silent', async () => {
    for (const sourceCommonDir of ['/separate-n1/.git', undefined]) {
      const f = await modeRuntime({ grants, mode: { mode: 'standart' } });
      execFileSync('git', ['init', '-q'], { cwd: f.project }); identity.sourceCommonDir = sourceCommonDir;
      expect((await f.call('edit_file', edit)).card).toBe(false);
      expect(await readFile(join(f.project, 'src', 'a.ts'), 'utf8')).toBe('export const a = 2;\n');
    }
  });

  // B3 (owner terminal test 2026-10-07): `rm src/deneme.md` ran without a card in full-auto and failed in the sandbox with a bare "Read-only
  // file system". Real service turn, real policy, real bubblewrap: the result now names the protected path, why, and what can change it.
  it.skipIf(!bwrapReady)('B3: a full-auto shell write on the self-source floor fails read-only in bubblewrap and the result explains it', async () => {
    const live = [rule('shell-tool', 'agent-tool', ['run_shell'], 'require-approval', true), rule('shell-run', 'operation', ['host.shell.run'], 'allow')];
    const f = await modeRuntime({ grants: live, mode: 'full-auto', shell: { schemaVersion: 1, realm: 'require-sandbox' } });
    execFileSync('git', ['init', '-q'], { cwd: f.project });
    identity.sourceCommonDir = await realpath(join(f.project, '.git'));
    for (const command of ['rm src/a.ts', 'rm src/a.ts && echo silindi || echo silemedi']) {
      const result = await f.call('run_shell', { command });
      expect(result.card, command).toBe(false);
      expect(result.text, command).toMatch(/^\[deckent\] run_shell: sandbox: bubblewrap; /u);
      expect(result.text, command).toContain('Read-only file system');
      expect(result.text, command).toContain("\n[deckent] src/a.ts: protected path (Deckent's own source or the write floor). In this sandbox the shell sees it read-only");
      expect(await readFile(join(f.project, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
    }
    // Negative: an ordinary project write in the same turn shape gets no note.
    const plain = await f.call('run_shell', { command: 'echo x > notes.txt' });
    expect(plain.card).toBe(false); expect(plain.text).not.toContain('protected path');
  }, 120_000);
});
