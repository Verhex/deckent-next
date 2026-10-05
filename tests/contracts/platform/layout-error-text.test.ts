import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clearConfigCache, loadConfig, ConfigValidationError, ErrorRegistry, exitCodeFor } from '#platform/index.js';

const LAYOUT_CODES = ['LAYOUT_VERSION_UNSUPPORTED', 'LAYOUT_ROOT_INVALID', 'LAYOUT_RESOURCE_INVALID', 'LAYOUT_RESOURCE_UNKNOWN', 'LAYOUT_PATH_UNEXPRESSIBLE'] as const;
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function loadWith(layout: unknown, language?: 'en' | 'tr'): Promise<ConfigValidationError> {
  const root = await mkdtemp(join(tmpdir(), 'deckent-layout-text-')); roots.push(root);
  const project = join(root, 'project'); await mkdir(join(project, '.deckent'), { recursive: true });
  await writeFile(join(project, '.deckent', 'config.json'), JSON.stringify({ layout }), { mode: 0o600 });
  const env = { HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), ...(language ? { DECKENT_LANGUAGE: language } : {}) };
  const error = await loadConfig(project, { env }).then(() => undefined, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(ConfigValidationError);
  return error as ConfigValidationError;
}

describe('layout errors reach the surface as human text (KATALOG-TEMIZLIK)', () => {
  it('registers every LAYOUT_* code as a typed config error with distinct EN and TR sentences', () => {
    for (const code of LAYOUT_CODES) {
      expect(ErrorRegistry.has(code)).toBe(true);
      const en = ErrorRegistry.get(code, 'en')!.message, tr = ErrorRegistry.get(code, 'tr')!.message;
      expect(en.length).toBeGreaterThan(40); expect(tr.length).toBeGreaterThan(40);
      expect(en).not.toBe(tr); expect(en).not.toContain(code); expect(tr).not.toContain(code);
      expect(exitCodeFor(ErrorRegistry.createError(code))).toBe(78);
    }
  });
  const cases: ReadonlyArray<readonly [string, unknown, string, RegExp, RegExp]> = [
    ['LAYOUT_ROOT_INVALID', { root: 'relative/data' }, 'tr', /absolute path/, /mutlak/],
    ['LAYOUT_PATH_UNEXPRESSIBLE', { root: '/tmp/deckent?data' }, 'tr', /\* or \?/, /\* ya da \?/],
    ['LAYOUT_RESOURCE_INVALID', { resources: { memory: '../escape' } }, 'tr', /relative path/, /göreli/],
    ['LAYOUT_RESOURCE_UNKNOWN', { resources: { notAResource: 'x' } }, 'tr', /does not define/, /tanımlamadığı/],
  ];
  for (const [code, layout, , enText, trText] of cases) {
    it(`${code} from a real configuration renders the English and the Turkish sentence, not the bare code`, async () => {
      const en = await loadWith(layout, 'en'), tr = await loadWith(layout, 'tr');
      expect(en.message).toContain(`${code}: `); expect(en.message).toMatch(enText); expect(en.message).not.toMatch(trText);
      expect(tr.message).toContain(`${code}: `); expect(tr.message).toMatch(trText); expect(tr.message).not.toMatch(enText);
      // The locale-lazy renderer re-renders the same issue in the other locale (surface switches language after construction).
      expect(en.localize!('tr').message).toMatch(trText);
      expect(en.issues).toEqual([{ path: 'layout', reason: code }]);
    });
  }
  it('leaves a reason that is not a registered code literal (negative: schema issue names are not rewritten)', () => {
    const error = new ConfigValidationError([{ path: 'a.b', reason: 'too_small' }, { path: 'c.d', reason: 'constructor' }], 'en');
    expect(error.message).toContain('too_small'); expect(error.message).not.toContain('too_small:');
    expect(error.message).toContain('(constructor)');
  });
});
