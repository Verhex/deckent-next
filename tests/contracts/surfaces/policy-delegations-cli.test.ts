import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { main } from '#surfaces/core/cli/index.js';
import { getDecisionSteps, type DelegationCommand, type DecisionDelegationView } from '#domain/index.js';
import { clearConfigCache, ErrorRegistry } from '#platform/index.js';
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'delegation-cli-')); roots.push(root);
  await mkdir(join(root, '.deckent')); await writeFile(join(root, '.deckent/config.json'), '{}');
  const view: DecisionDelegationView = { schemaVersion: 1, scopeId: 's', revision: 'p+b', resourceId: null, principal: { issuer: 'host/mcp', subject: 'person' },
    steps: getDecisionSteps().map(step => ({ step, managed: 'none', effective: 'denied' })) };
  const seen: DelegationCommand[] = [], text = { out: '', err: '' };
  const context = { root, env: { DECKENT_GLOBAL_HOME: join(root, 'global') }, stdout: { write: (s: string) => { text.out += s; } }, stderr: { write: (s: string) => { text.err += s; } },
    delegations: { inspect: async () => view, change: async (_root: string, command: DelegationCommand) => { seen.push(command); throw ErrorRegistry.createError('APPROVAL_INTERACTIVE_REQUIRED'); } } };
  return { context, seen, text };
}
it('EN/TR listing has all steps, managed and effective state; JSON stays data-only', async () => {
  const f = await fixture();
  for (const locale of ['tr', 'en']) {
    f.text.out = '';
    expect(await main(['policy', 'delegations', '--scope', 's', '--lang', locale], f.context)).toBe(0);
    for (const step of getDecisionSteps()) expect(f.text.out).toContain(step.id);
    // C-APPROVE: plain on/off words (owner "kapalı / açık"), the scope named.
    expect(f.text.out).toContain(locale === 'tr' ? 'kapalı' : 'off'); expect(f.text.out).toContain('s');
    f.text.out = '';
    expect(await main(['policy', 'delegations', '--scope', 's', '--json', '--lang', locale], f.context)).toBe(0);
    expect(JSON.parse(f.text.out).revision).toBe('p+b');
  }
  expect(f.seen).toEqual([]);
});
it('grant/revoke bind the inspected revision, exact selected resource and MCP actor; non-TTY refusal remains typed', async () => {
  const f = await fixture();
  for (const action of ['delegate', 'undelegate']) {
    f.text.err = '';
    expect(await main(['policy', action, '--scope', 's', '--step', 'run-resume', '--resource', 'r', '--actor', 'mcp', '--json'], f.context)).not.toBe(0);
    expect(f.text.err).toContain('APPROVAL_INTERACTIVE_REQUIRED');
    expect(f.seen.at(-1)).toMatchObject({ schemaVersion: 1, scopeId: 's', step: 'run-resume', resourceId: 'r', actor: 'mcp', expectedRevision: 'p+b', action: action === 'delegate' ? 'grant' : 'revoke' });
  }
});
it('floor/unknown steps, unknown actor, --yes, duplicate scope and arbitrary policy data never reach mutation', async () => {
  const f = await fixture();
  for (const suffix of [['--step', 'secret-read'], ['--step', 'run-resume', '--actor', 'owner'], ['--step', 'run-resume', '--yes'],
    ['--step', 'run-resume', '--scope', 's'], ['--step', 'run-resume', '--grant', '{}'], []])
    expect(await main(['policy', 'delegate', '--scope', 's', ...suffix], f.context)).not.toBe(0);
  expect(f.seen).toEqual([]);
});
