import { expect, it } from 'vitest';
import { main } from '#surfaces/index.js';

// SCR-B (owner 2026-09-28): CLI surface for `deckent init policy --scope <id> [--preview|--apply]`, isolated
// from the real composition wiring (fake context handlers), mirroring installation-apply-cli.test.ts's style
// for the heavy install (through the public `main` entry, exit codes rather than thrown errors).
function context(overrides: Record<string, unknown> = {}) {
  return { root: '/project', env: {},
    async previewPolicyTemplateInstallation(root: string, scopeId: string) { return { status: 'preview', root, scopeId }; },
    async applyPolicyTemplateInstallation(root: string, scopeId: string) { return { status: 'installed', root, scopeId }; },
    ...overrides };
}

it('requires exactly one of --preview/--apply and an explicit --scope', async () => {
  for (const argv of [['init', 'policy'], ['init', 'policy', '--scope', 'x'], ['init', 'policy', '--preview'],
    ['init', 'policy', '--scope', 'x', '--preview', '--apply'], ['init', 'policy', '--scope', '-x', '--preview']]) {
    expect(await main(argv, context())).toBe(2);
  }
});
it('never accepts the heavy install\'s profile/docker/proposal flags', async () => {
  expect(await main(['init', 'policy', '--scope', 'x', '--preview', '--profile', 'f.json'], context())).toBe(2);
  expect(await main(['init', 'policy', '--scope', 'x', '--preview', '--accept-custom'], context())).toBe(2);
});
it('dispatches --preview to the preview handler and --apply to the apply handler, unmodified scope and root', async () => {
  const previewCalls: [string, string][] = [], applyCalls: [string, string][] = [], output: string[] = [];
  const ctx = context({
    async previewPolicyTemplateInstallation(root: string, scopeId: string) { previewCalls.push([root, scopeId]); return { status: 'preview' }; },
    async applyPolicyTemplateInstallation(root: string, scopeId: string) { applyCalls.push([root, scopeId]); return { status: 'installed' }; },
    stdout: { write(value: string) { output.push(value); } },
  });
  expect(await main(['init', 'policy', '--scope', 'installation', '--preview', '--json'], ctx)).toBe(0);
  expect(previewCalls).toEqual([['/project', 'installation']]); expect(applyCalls).toEqual([]);
  expect(JSON.parse(output.join(''))).toEqual({ status: 'preview' });
  output.length = 0;
  expect(await main(['init', 'policy', '--scope', 'installation', '--apply', '--json'], ctx)).toBe(0);
  expect(applyCalls).toEqual([['/project', 'installation']]);
  expect(JSON.parse(output.join(''))).toEqual({ status: 'installed' });
});
it('is refused (exit 2, never silently ignored) when the composition root did not wire the handler', async () => {
  expect(await main(['init', 'policy', '--scope', 'x', '--preview'], context({ previewPolicyTemplateInstallation: undefined }))).toBe(2);
  expect(await main(['init', 'policy', '--scope', 'x', '--apply'], context({ applyPolicyTemplateInstallation: undefined }))).toBe(2);
});
it('--upgrade (owner 2026-10-07: first-run v4 → v5) reads with --preview, writes only with --apply, and says in words what happened', async () => {
  const calls: [string, string, boolean][] = [], output: string[] = [];
  let status = 'preview';
  const ctx = context({ async upgradePolicyTemplateInstallation(root: string, scopeId: string, apply: boolean) { calls.push([root, scopeId, apply]); return { status }; },
    stdout: { write(value: string) { output.push(value); } } });
  expect(await main(['init', 'policy', '--scope', 'installation', '--upgrade', '--preview', '--lang', 'en'], ctx)).toBe(0);
  expect(output.join('')).toContain('Nothing was written; run it again with --apply.');
  output.length = 0; status = 'unavailable';
  expect(await main(['init', 'policy', '--scope', 'installation', '--upgrade', '--apply', '--lang', 'tr'], ctx)).toBe(0);
  expect(output.join('')).toContain('yeniden yazılmadı');
  expect(calls).toEqual([['/project', 'installation', false], ['/project', 'installation', true]]);
  // Exactly one of --preview/--apply, and the handler must be wired.
  expect(await main(['init', 'policy', '--scope', 'installation', '--upgrade'], ctx)).toBe(2);
  expect(await main(['init', 'policy', '--scope', 'installation', '--upgrade', '--apply'], context())).toBe(2);
});
