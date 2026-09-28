import { describe, expect, it } from 'vitest';
import { resolvePolicyBindings, STANDING_GRANT_KIND, type ShellRealmContainment } from '#domain/index.js';
import { classifyShellContainment, decideAgentToolCall, standingWouldLower, type AgentToolCallCell } from '#engine/index.js';

// SHELL-AUTONOMY (owner 2026-09-28): the one decision function takes the planned realm's containment and the command's containment.
// Only full-auto ∧ enforced sandbox ∧ contained lowers the shell cells the classifier could not bound; never destructive, never on the
// host or a degraded sandbox, never in ask or auto-edit, and only over a company-eligible require-approval (unchanged).
const me = { issuer: 'host', subject: '1000' };
const principal = { id: 'os:1000', ...me, assurance: 'os-user' as const, scopeIds: ['scope'] };
const rule = (id: string, kind: string, ids: string[], effect: string, eligible?: boolean) => ({ id, effect, actions: [kind === 'operation' ? 'execute' : 'invoke'],
  scopes: ['scope'], principals: [me], resource: { kind, ids }, ...(eligible === undefined ? {} : { modeEligible: eligible }) });
const policy = (mode: string, toolEffect = 'require-approval', eligible = true) => resolvePolicyBindings(
  { schemaVersion: 2, revision: 'p', roles: [], separationOfDuties: [], restrictions: [], grants: [rule('shell-tool', 'agent-tool', ['run_shell'], toolEffect, toolEffect === 'require-approval' ? eligible : undefined),
    rule('shell-run', 'operation', ['host.shell.run'], 'allow')] },
  { schemaVersion: 2, revision: 'b', bindings: [], modes: [{ id: 'me-mode', principal: me, scopes: ['scope'], mode }] });
const decide = (snapshot: unknown, cell: AgentToolCallCell, realm?: ShellRealmContainment, contained = true) => decideAgentToolCall(snapshot, { principal,
  scopeId: 'scope', tool: { name: 'run_shell' }, operation: { id: 'host.shell.run' }, cell, ...(realm ? { shell: { realm, contained } } : {}) });
const UNBOUNDED: readonly AgentToolCallCell[] = ['shell-read-none', 'shell-read-low', 'shell-other-modify', 'shell-always-ask'];

describe('full-auto inside an enforced sandbox (SHELL-AUTONOMY decision)', () => {
  it('lowers the unbounded shell cells only in full-auto, in a sandbox realm, for a contained command, audited as shell-modify', () => {
    for (const cell of UNBOUNDED) {
      expect(decide(policy('full-auto'), cell, 'sandbox')).toMatchObject({ decision: 'allow', relaxation: { mode: 'full-auto', cell: 'shell-modify', company: 'shell-tool', person: 'me-mode' } });
      for (const realm of ['degraded', 'host'] as const) expect({ cell, realm, ...decide(policy('full-auto'), cell, realm) }).toMatchObject({ decision: 'require-approval', relaxation: null });
      expect(decide(policy('full-auto'), cell)).toMatchObject({ decision: 'require-approval', relaxation: null });
      expect(decide(policy('full-auto'), cell, 'sandbox', false)).toMatchObject({ decision: 'require-approval', relaxation: null });
      for (const mode of ['ask', 'auto-edit']) expect(decide(policy(mode), cell, 'sandbox')).toMatchObject({ decision: 'require-approval', relaxation: null });
      // Not over a rule the company did not mark eligible, and a raised allow is never lowered (unchanged rules).
      expect(decide(policy('full-auto', 'require-approval', false), cell, 'sandbox')).toMatchObject({ decision: 'require-approval', relaxation: null });
      expect(decide(policy('full-auto', 'allow'), cell, 'sandbox')).toMatchObject({ decision: cell === 'shell-read-none' ? 'allow' : 'require-approval', relaxation: null });
    }
  });

  it('never lowers the destructive table, the write floor or a read tool, in any realm', () => {
    for (const cell of ['shell-destructive', 'edit-floor', 'read'] as const) {
      for (const realm of ['sandbox', 'degraded', 'host'] as const) expect({ cell, realm, ...decide(policy('full-auto'), cell, realm) }).toMatchObject({ decision: 'require-approval', relaxation: null });
    }
  });

  it('keeps the narrow mutating set as before: full-auto, any realm', () => {
    for (const realm of ['sandbox', 'degraded', 'host'] as const) expect(decide(policy('full-auto'), 'shell-narrow-mutating', realm, false)).toMatchObject({ decision: 'allow' });
    expect(decide(policy('auto-edit'), 'shell-narrow-mutating', 'sandbox')).toMatchObject({ decision: 'require-approval' });
  });
});

describe('classifyShellContainment (SHELL-AUTONOMY)', () => {
  const floor = (text: string) => /(?:^|\/)(package\.json|\.github)(?:\/|$)/u.test(text);
  const contained = (command: string) => classifyShellContainment(command, floor);
  it.each([
    'touch /tmp/deckent-policy-test-$$ && ls -la /tmp/deckent-policy-test-$$', 'echo "policy test $(date +%H:%M:%S)"', 'echo "x" && date && whoami',
    'touch /tmp/full-auto-test && echo "ok: $(ls /tmp/full-auto-test)"', 'rm -f auto-edit-test.txt && echo silindi', 'for f in src/*.ts; do wc -l "$f"; done',
    'cd src && ls | sort; echo done > out.txt', 'X=1 printenv X', 'ls src | tee listing.txt', 'test -f a || [ -d b ]', '(cd src && ls)', 'find . -name "*.ts"', 'f=pack; echo x >> ${f}age.json',
  ])('contained: %s', command => { expect(contained(command)).toEqual({ contained: true, reasonCode: 'CONTAINED' }); });
  it.each([
    ['echo "$(python3 -c 1)"', 'PROGRAM_FLOOR', 'python3'], ['npm test && echo ok', 'PROGRAM_FLOOR', 'npm'], ['ls | xargs cat', 'PROGRAM_FLOOR', 'xargs'],
    ['curl -s http://x/ || true', 'PROGRAM_FLOOR', 'curl'], ['sudo true', 'PROGRAM_FLOOR', 'sudo'], ['env python3 x', 'PROGRAM_FLOOR', 'env'],
    ['find . -exec sh -c 1 \\;', 'PROGRAM_FLOOR', 'find'], ['while true; do bash -c x; done', 'PROGRAM_FLOOR', 'bash'], ['`echo ruby` x', 'PROGRAM_UNKNOWN', '__shell_substitution__'],
    ['$CMD x', 'PROGRAM_UNKNOWN', '$CMD'], ['./build.sh', 'PROGRAM_UNKNOWN', './build.sh'], ['diff <(python3 a) b', 'PROCESS_SUBSTITUTION', '<(python3'],
    ['echo x >> package.json', 'PROTECTED_NAME', 'package.json'], ['echo x >package.json', 'PROTECTED_NAME', 'package.json'],
    ['mkdir -p .github/workflows && touch .github/workflows/ci.yml', 'PROTECTED_NAME', '.github/workflows'], ['sleep 1 &', 'UNPARSEABLE', undefined],
    ['echo "unterminated', 'UNPARSEABLE', undefined], ['case foo in a) python3 x;; esac', 'PROGRAM_UNKNOWN', 'case'],
  ])('asks: %s → %s', (command, reasonCode, detail) => {
    expect(contained(command)).toEqual({ contained: false, reasonCode, ...(detail === undefined ? {} : { detail }) });
  });
  it('refuses PowerShell and empty commands', () => {
    expect(classifyShellContainment('ls', floor, 'powershell')).toMatchObject({ contained: false, reasonCode: 'UNSUPPORTED_DIALECT' });
    expect(contained('   ')).toMatchObject({ contained: false, reasonCode: 'EMPTY_COMMAND' });
  });
});

// Merge with PERSISTENT-APPROVALS (lead 2026-09-29): one decision, the mode first and the standing approval last. `shell-read-low` is both a
// standing cell and a sandbox cell, so with a standing grant, a session memory, full-auto and an enforced sandbox all present, the mode
// lowers it (a `permission-mode` event); on the host the standing approval does (a `standing-approval` event); the audit tells them apart.
describe('sandbox mode relaxation and standing approvals together (SHELL-AUTONOMY × PERSISTENT-APPROVALS)', () => {
  const KEY = 'v1:run_shell:command:find . -writable';
  const withStanding = (mode: string) => resolvePolicyBindings({ schemaVersion: 2, revision: 'p', roles: [], separationOfDuties: [], restrictions: [], grants: [
    rule('shell-tool', 'agent-tool', ['run_shell'], 'require-approval', true), rule('shell-run', 'operation', ['host.shell.run'], 'allow'),
    { ...rule('standing-1', STANDING_GRANT_KIND, [KEY], 'allow'), actions: ['invoke'] }] },
    { schemaVersion: 2, revision: 'b', bindings: [], modes: [{ id: 'me-mode', principal: me, scopes: ['scope'], mode }] });
  const request = (realm: ShellRealmContainment, contained = true, session = true) => ({ principal, scopeId: 'scope', tool: { name: 'run_shell' },
    operation: { id: 'host.shell.run' }, cell: 'shell-read-low' as const, shell: { realm, contained }, standing: { key: KEY, session } });
  it('full-auto inside a sandbox: the mode lowers first, the standing approval is not used', () => {
    const decided = decideAgentToolCall(withStanding('full-auto'), request('sandbox'));
    expect(decided).toMatchObject({ decision: 'allow', relaxation: { mode: 'full-auto', cell: 'shell-modify' } });
    expect(decided.standing).toBeUndefined();
  });
  it('where no mode lowers (host, degraded, not contained, ask), the standing approval is the last resort', () => {
    for (const [mode, realm, contained] of [['full-auto', 'host', true], ['full-auto', 'degraded', true], ['full-auto', 'sandbox', false], ['ask', 'sandbox', true]] as const) {
      expect({ mode, realm, contained, ...decideAgentToolCall(withStanding(mode), request(realm, contained)) })
        .toMatchObject({ decision: 'allow', relaxation: null, standing: { source: 'grant', key: KEY, grantId: 'standing-1' } });
    }
  });
  it('standingWouldLower with a shell field: no scope is offered where the mode already lowers, one is where it does not', () => {
    expect(standingWouldLower(withStanding('full-auto'), request('sandbox', true, false))).toBe(false);
    expect(standingWouldLower(withStanding('full-auto'), request('host', true, false))).toBe(true);
    expect(standingWouldLower(withStanding('ask'), request('sandbox', true, false))).toBe(true);
  });
});
