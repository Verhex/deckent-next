import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolvePolicyBindings, type VerifiedPrincipal } from '#domain/index.js';
import * as engine from '#engine/index.js';
import { createShellPathContext, createShellWriteContext, createWorkspaceScope } from '#adapters/index.js';
import { SHELL_CELLS } from '#composition/core/agent-turn/index.js';

// Lead decision 2026-10-21 on the PRE-8 finding (law audit MAJOR 2; owner rules "AI cannot approve", "the hard floor stays closed in full access"):
// the product's authority commands — `deckent secret grant|revoke|set|delete|handover|store`, `deckent approval decide`, `deckent init policy … --apply|--modes`
// — and any reach of them through a pty wrapper (`script`, `unbuffer`, `expect`) or a shell `-c` string are the `edit-authority` cell: a person's card in
// every mode, full access included; an AI actor is denied. A pty wrapper whose payload cannot be read keeps the card. Ordinary commands keep their tier.
const classify = engine.classifyShellAuthority;
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));
async function tierOf(command: string) {
  const base = await mkdtemp(join(tmpdir(), 'dn-shell-authority-')); roots.push(base); await mkdir(join(base, 'src'));
  const scope = await createWorkspaceScope(base), paths = createShellPathContext(scope);
  const readOnly = await engine.classifyReadOnlyShellCommand(command, paths), risk = engine.classifyShellRisk(command, readOnly);
  const mutation = await engine.classifyShellMutation(command, paths, createShellWriteContext(scope));
  return engine.shellPermissionTier(risk, readOnly, mutation, classify(command));
}
const me = { issuer: 'host', subject: '1000' }, human: VerifiedPrincipal = { id: 'me', ...me, assurance: 'os-user', scopeIds: ['scope'] };
const ai: VerifiedPrincipal = { ...human, id: 'mcp', issuer: 'host/mcp', assurance: 'workload-verified' };
/** A full-access turn: shell and its operation allowed, the company full-access grant, the person's full-access mode. */
const policy = (principal: { issuer: string; subject: string }) => resolvePolicyBindings({ schemaVersion: 2, revision: 'fa', roles: [], separationOfDuties: [], restrictions: [], grants: [
  { id: 'shell', effect: 'allow', actions: ['invoke'], scopes: ['scope'], principals: [principal], resource: { kind: 'agent-tool', ids: ['run_shell'] } },
  { id: 'run', effect: 'allow', actions: ['execute'], scopes: ['scope'], principals: [principal], resource: { kind: 'operation', ids: ['host.shell.run'] } },
  { id: 'fa', effect: 'allow', actions: ['set'], scopes: ['scope'], principals: [principal], resource: { kind: 'permission-mode', ids: ['full-access'] } }] },
{ schemaVersion: 3, revision: 'b', bindings: [], modes: [{ id: 'm', principal, scopes: ['scope'], mode: 'full-access' }] });
const decide = async (command: string, principal = human) => engine.decideAgentToolCall(policy({ issuer: principal.issuer, subject: principal.subject }), { principal, scopeId: 'scope',
  tool: { name: 'run_shell' }, operation: { id: 'host.shell.run' }, cell: SHELL_CELLS[await tierOf(command)], shell: { realm: 'host', contained: false }, fullAccess: true }).decision;

const AUTHORITY = ['deckent secret grant DECKENT_ANTHROPIC_KEY --scope s --json', 'deckent secret set K --main', 'deckent secret delete K --scope s', 'deckent approval decide abc approve',
  'deckent init policy --scope s --upgrade --apply', 'deckent init policy --modes --scope s', 'ls && deckent secret grant K', '/usr/local/bin/deckent secret grant K',
  'script -qc "deckent secret grant K --scope s --json" /dev/null', "script -qc 'deckent approval decide x approve'", 'unbuffer deckent secret set K --main',
  "expect -c 'spawn deckent secret grant K'", 'bash -c "deckent secret grant K"', 'sh -c "script -qc \\"deckent secret grant K\\" /dev/null"',
  'script -qc "$CMD" /dev/null', "echo 'deckent secret grant K --scope s --json' | bash", "printf 'deckent approval decide x approve' | sh -s",
  'exec deckent secret grant K', 'exec 3<>/dev/tcp/x/1 && exec deckent secret grant K',
  "bash <<< 'deckent secret grant K --scope s --json'", 'sh < /tmp/x.sh', "bash <(printf 'deckent secret grant K')", "sh -s <<EOF\ndeckent approval decide x approve\nEOF",
  'bash 0< /tmp/x.sh', 'sh -s < /tmp/x.sh', "zsh <<< 'deckent init policy --modes'", 'unbuffer $TOOL', 'node dist/composition/core/cli/internal/entry.js secret grant K --scope s', 'npx deckent secret grant K'];
const ORDINARY = ['exec 3<>/dev/tcp/127.0.0.1/8080 && printf \'GET / HTTP/1.0\\r\\n\\r\\n\' >&3 && cat <&3', 'exec 2>/dev/null', 'script -qc "npm test" /dev/null', 'git commit -m "secret set later"', 'echo deckent secret grant', 'deckent secret list', 'deckent init policy --preview',
  'bash -c "npm run build"', 'unbuffer npm test'];

describe.skipIf(process.platform !== 'linux')('PRE-8 authority commands are the edit-authority floor in every mode', () => {
  it.each(AUTHORITY)('full access asks the person for %s (red before: allowed without a card)', async command => {
    expect(await decide(command)).toBe('require-approval');
    expect(await decide(command, ai)).toBe('deny');
  });
  it.each(ORDINARY)('ordinary full-access work is unchanged: %s', async command => {
    expect(classify(command)).toBe(false);
    expect(await decide(command)).toBe('allow');
  });
});

// Astra REVISE 2702 P1-A: a wrapper's shell payload is decoded like the inner shell decodes it (quote removal, escapes, ANSI-C quoting, brace
// expansion); a payload that cannot be decoded safely (expansion, substitution) keeps the card. Every authority command, every variant.
const AUTHORITY_ARGV: readonly (readonly [string, string, string])[] = [['secret', 'grant', 'K --scope s --json'], ['secret', 'set', 'K --main'], ['secret', 'delete', 'K'],
  ['approval', 'decide', 'x approve'], ['init', 'policy', '--upgrade --apply'], ['init', 'policy', '--modes']];
const split = (word: string) => [word.slice(0, 2), word.slice(2)] as const;
const QUOTED = AUTHORITY_ARGV.flatMap(([group, action, rest]) => {
  const [g1, g2] = split(group), [a1, a2] = split(action);
  return [`script -qc 'deckent ${g1}""${g2} ${a1}""${a2} ${rest}' /dev/null`, `script -qc "deckent ${g1}''${g2} ${action} ${rest}" /dev/null`,
    `script -qc 'deckent ${g1}\\${g2} ${action} ${rest}' /dev/null`, `bash -c "deckent \\$'${group}' ${action} ${rest}"`, `sh -c 'deckent $G ${action} ${rest}'`,
    `sh -c 'deckent $(printf ${group}) ${action} ${rest}'`, `deckent ${g1}$'${g2}' ${action} ${rest}`, `deckent {${group},} ${action} ${rest}`,
    `unbuffer bash -c 'deckent ${g1}""${g2} ${action} ${rest}'`, `deckent ${g1}*${g2.slice(-1)} ${action} ${rest}`,
    `unbuffer deckent [${group[0]}]${group.slice(1)} ${action} ${rest}`, `npx deckent ${group.slice(0, -1)}? ${action} ${rest}`, `sh -c 'deckent ${g1}*${g2.slice(-1)} ${action} ${rest}'`,
    `sudo deckent ${group.slice(0, -1)}[${group.slice(-1)}] ${action} ${rest}`, `expect -c 'spawn deckent ${g1}""${g2} ${action} ${rest}'`];
});
describe.skipIf(process.platform !== 'linux')('REVISE 2702 P1-A: quoted and undecodable payloads of the authority commands keep the card', () => {
  it.each(QUOTED)('%s → edit-authority (person asked, AI denied)', async command => {
    expect(classify(command), command).toBe(true);
    expect(await decide(command)).toBe('require-approval');
    expect(await decide(command, ai)).toBe('deny');
  });
});
