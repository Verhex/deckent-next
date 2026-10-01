import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { main } from '#surfaces/core/cli/index.js';
import { clearConfigCache } from '#platform/index.js';

// PERSISTENT-APPROVALS G6: `deckent policy grants --mine` (read-only) and `deckent policy revoke <id>` until `/policy` exists. The surface owns
// no rule: it renders the engine's view, confirms a revoke on a terminal (or with --yes) and names what changed.
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-grants-cli-')); roots.push(root);
  const home = join(root, 'home'); await mkdir(home); await mkdir(join(root, '.deckent'));
  await writeFile(join(root, '.deckent/config.json'), JSON.stringify({}));
  return { root, env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? '/usr/bin:/bin' } };
}
const grant = { id: 'standing-abc', key: 'v1:run_shell:command:npm test', tool: 'run_shell', kind: 'command' as const, text: 'npm test' };
const sink = () => { const out = { text: '' }; return { out, stdout: { write(value: string) { out.text += value; } } }; };

it('lists only the caller\'s standing approvals (needs --mine), as text and as JSON, and says so when there are none', async () => {
  const f = await fixture(), seen: unknown[] = [];
  const listStandingGrants = async (_root: string, scopeId: string) => { seen.push(scopeId); return [grant]; };
  const text = sink();
  expect(await main(['policy', 'grants', '--mine', '--scope', 'scope-a', '--lang', 'en'], { ...f, stdout: text.stdout, listStandingGrants })).toBe(0);
  expect(text.out.text).toContain('standing-abc'); expect(text.out.text).toContain('npm test'); expect(seen).toEqual(['scope-a']);
  // No --scope and no configured terminal scope: typed usage-level refusal, nothing read.
  expect(await main(['policy', 'grants', '--mine'], { ...f, stdout: sink().stdout, stderr: sink().stdout, listStandingGrants })).not.toBe(0);
  expect(seen).toEqual(['scope-a']);
  const json = sink();
  expect(await main(['policy', 'grants', '--mine', '--json', '--scope', 'scope-b'], { ...f, stdout: json.stdout, listStandingGrants })).toBe(0);
  expect(JSON.parse(json.out.text)).toEqual([grant]); expect(seen).toEqual(['scope-a', 'scope-b']);
  const none = sink();
  expect(await main(['policy', 'grants', '--mine', '--scope', 'scope-a', '--lang', 'tr'], { ...f, stdout: none.stdout, listStandingGrants: async () => [] })).toBe(0);
  expect(none.out.text).toContain('kalıcı onayınız yok');
  // Without --mine (or an unknown flag) it is a usage error and nothing is read.
  for (const argv of [['policy', 'grants', '--scope', 'scope-a'], ['policy', 'grants', '--mine', '--all'], ['policy', 'grants', '--mine', '--yes']]) {
    seen.length = 0;
    expect(await main(argv, { ...f, stdout: sink().stdout, stderr: sink().stdout, listStandingGrants })).not.toBe(0);
    expect(seen).toEqual([]);
  }
});

it('revoke: --yes confirms, no terminal and no --yes keeps the grant, an unknown id changes nothing; the handler receives the exact id and scope', async () => {
  const f = await fixture(), calls: { id: string; scopeId: string; confirmed: boolean | null }[] = [];
  const revokeStandingGrant = async (_root: string, input: { scopeId: string; id: string; confirm: (row: typeof grant) => Promise<boolean> }) => {
    if (input.id !== grant.id) { calls.push({ id: input.id, scopeId: input.scopeId, confirmed: null }); return { revoked: false, grant: null }; }
    const confirmed = await input.confirm(grant);
    calls.push({ id: input.id, scopeId: input.scopeId, confirmed });
    return { revoked: confirmed, grant };
  };
  const yes = sink();
  expect(await main(['policy', 'revoke', 'standing-abc', '--scope', 'scope-a', '--yes', '--lang', 'en'], { ...f, stdout: yes.stdout, revokeStandingGrant })).toBe(0);
  expect(yes.out.text).toContain('revoked');
  const kept = sink();
  // The test process has no TTY on stdin: without --yes the person is not asked, so nothing is confirmed.
  expect(await main(['policy', 'revoke', 'standing-abc', '--scope', 'scope-a', '--lang', 'en'], { ...f, stdin: Object.assign(new (await import('node:stream')).PassThrough(), { isTTY: false }) as never, stdout: kept.stdout, revokeStandingGrant })).toBe(0);
  expect(kept.out.text).toContain('kept');
  const missing = sink();
  expect(await main(['policy', 'revoke', 'standing-zzz', '--scope', 'scope-a', '--yes', '--lang', 'en'], { ...f, stdout: missing.stdout, revokeStandingGrant })).toBe(0);
  expect(missing.out.text).toContain('nothing changed');
  expect(calls).toEqual([{ id: 'standing-abc', scopeId: 'scope-a', confirmed: true }, { id: 'standing-abc', scopeId: 'scope-a', confirmed: false }, { id: 'standing-zzz', scopeId: 'scope-a', confirmed: null }]);
  expect(await main(['policy', 'revoke', '--scope', 'scope-a', '--yes'], { ...f, stdout: sink().stdout, stderr: sink().stdout, revokeStandingGrant })).not.toBe(0);
});
