import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { afterEach, expect, it } from 'vitest';
import { main } from '#surfaces/core/cli/index.js';
import { clearConfigCache } from '#platform/index.js';
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 };
const query = { schemaVersion: 2, scopeId: 'scope', invocationId: 'call', reference };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-invocation-cli-')); roots.push(root);
  const home = join(root, 'home'); await mkdir(home); await mkdir(join(root, '.deckent'));
  await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ cli: { invocationInputMaxBytes: 1024 } }));
  return { root, env: { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin' } };
}
it('reads file and stdin queries through one inspection contract and renders EN/TR states', async () => {
  const f = await fixture(), path = join(f.root, 'query.json'); await writeFile(path, JSON.stringify(query));
  for (const language of ['en', 'tr']) {
    let output = '', calls = 0;
    const code = await main(['models', 'invocation', '--input', language === 'en' ? path : '-', '--lang', language], {
      ...f, stdin: Readable.from([JSON.stringify(query)]), stdout: { write(text) { output += text; } },
      inspectModelInvocation: async (_root, input) => { calls++; expect(input).toEqual(query); return { ...input, invocation: null, contentStatus: null }; },
    });
    expect(code).toBe(0); expect(calls).toBe(1); expect(output).toContain(language === 'en' ? 'No invocation receipt' : 'Çağrı kaydı bulunamadı');
  }
});
it('rejects invalid/oversized/interactive input before an application call without echoing its content', async () => {
  const f = await fixture(); let calls = 0;
  for (const input of ['{"nativeRequest":"sensitive-marker"}', 'sensitive-marker'.repeat(100)]) {
    let errors = '';
    const code = await main(['models', 'invoke', '--input', '-', '--json'], { ...f, stdin: Readable.from([input]),
      stderr: { write(text) { errors += text; } }, stdout: { write() {} }, invokeModel: async () => { calls++; throw new Error('UNREACHABLE'); } });
    expect(code).not.toBe(0); expect(errors).not.toContain('sensitive-marker');
  }
  expect(await main(['models', 'invoke', '--input', '-'], { ...f, stdin: Object.assign(Readable.from([]), { isTTY: true }),
    stderr: { write() {} } })).not.toBe(0); expect(calls).toBe(0);
});
it('rejects duplicate or unsupported flags and provides help without opening config or transport', async () => {
  for (const argv of [['models', 'invoke', '--input', '-', '--input', '-'], ['models', 'invoke', '--prompt', 'hidden']]) {
    expect(await main(argv, { stderr: { write() {} } })).not.toBe(0);
  }
  let output = ''; expect(await main(['models', 'invoke', '--help'], { stdout: { write(text) { output += text; } } })).toBe(0);
  expect(output).toContain('--input');
});
