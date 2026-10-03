import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { realpath, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeModeRuntimes, modeRuntime, rule } from '../support/agent-turn-modes.js';

const identity = vi.hoisted(() => ({ sourceCommonDir: undefined as string | undefined }));
vi.mock('#platform/index.js', async importOriginal => ({ ...await importOriginal<Record<string, unknown>>(), readBuildIdentity: () =>
  ({ sourceTreeSha256: 'a'.repeat(64), sourceCommit: null, sourceDirty: false, ...(identity.sourceCommonDir ? { sourceCommonDir: identity.sourceCommonDir } : {}) }) }));
afterEach(async () => { identity.sourceCommonDir = undefined; await closeModeRuntimes(); });
const grants = [rule('edit', 'agent-tool', ['edit_file'], 'allow'), rule('write', 'operation', ['workspace.file.write'], 'allow')];
const edit = { path: 'src/a.ts', old_string: 'a = 1', new_string: 'a = 2' };

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
});
