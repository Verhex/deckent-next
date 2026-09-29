import { describe, expect, it } from 'vitest';
import { auditEventSchema, resolvePolicyBindings } from '#domain/index.js';
import { agentCallAuditEvent, decideAgentToolCall, type AgentToolCallCell } from '#engine/index.js';

// MODES-3 (owner 2026-09-29): the whole decision matrix of the three modes, cell × realm × person × company policy, against an oracle
// written from the owner's decision (not from the implementation). standart lowers an eligible ordinary edit (unless the person asks for
// edits too); full-auto adds the narrow shell, MCP calls and — in an enforced sandbox, for a contained command — the unbounded shell cells;
// full access (launched, on the company grant) lowers the floor raise and every eligible require-approval but the MCP ask pin and the
// configuration write. A deny is never lowered; a require-approval the company did not mark still asks in every mode.
const me = { issuer: 'host', subject: '1000' };
const principal = { id: 'os:1000', ...me, assurance: 'os-user' as const, scopeIds: ['scope'] };
const CELLS: readonly AgentToolCallCell[] = ['read', 'edit', 'edit-floor', 'edit-authority', 'shell-read-none', 'shell-read-low', 'shell-narrow-mutating', 'shell-destructive',
  'shell-always-ask', 'shell-other-modify', 'fetch-listed', 'fetch-unlisted', 'mcp-call', 'mcp-floor'];
const REALMS = ['host', 'sandbox-contained', 'sandbox-uncontained', 'degraded'] as const;
type Realm = typeof REALMS[number];
type Policy = 'allow' | 'eligible' | 'unmarked' | 'deny';
type Person = { readonly label: string; readonly entry: { mode: string; askEdits?: true } | null; readonly launched: boolean; readonly grant: 'allow' | 'deny' | null };
const PEOPLE: readonly Person[] = [
  { label: 'standart (no entry)', entry: null, launched: false, grant: null },
  { label: 'standart + askEdits', entry: { mode: 'standart', askEdits: true }, launched: false, grant: null },
  { label: 'full-auto', entry: { mode: 'full-auto' }, launched: false, grant: null },
  { label: 'full-auto + askEdits', entry: { mode: 'full-auto', askEdits: true }, launched: false, grant: 'allow' },
  { label: 'stored full-access, not launched', entry: { mode: 'full-access' }, launched: false, grant: 'allow' },
  { label: 'full-access launched', entry: null, launched: true, grant: 'allow' },
  { label: 'full-access launched + askEdits', entry: { mode: 'full-access', askEdits: true }, launched: true, grant: 'allow' },
  { label: 'full-access launched, no grant', entry: { mode: 'full-auto' }, launched: true, grant: null },
  { label: 'full-access launched, grant denied', entry: null, launched: true, grant: 'deny' },
];
const RAISING = new Set<AgentToolCallCell>(['edit-floor', 'edit-authority', 'shell-read-low', 'shell-narrow-mutating', 'shell-destructive', 'shell-always-ask', 'shell-other-modify',
  'fetch-unlisted', 'mcp-call', 'mcp-floor']);
const SANDBOX_CELLS = new Set<AgentToolCallCell>(['shell-read-none', 'shell-read-low', 'shell-narrow-mutating', 'shell-other-modify', 'shell-always-ask']);
const toolOf = (cell: AgentToolCallCell) => cell === 'read' ? 'read_file' : cell.startsWith('edit') ? 'edit_file' : cell.startsWith('shell') ? 'run_shell'
  : cell.startsWith('fetch') ? 'fetch_url' : 'mcp_tool';
const operationOf = (cell: AgentToolCallCell) => cell === 'read' ? null : cell.startsWith('edit') ? 'workspace.file.write' : cell.startsWith('shell') ? 'host.shell.run'
  : cell.startsWith('fetch') ? 'network.fetch' : 'mcp.tool.call';

/** The owner's decision as a table (independent of the implementation). */
function expected(cell: AgentToolCallCell, realm: Realm, person: Person, policy: Policy): 'allow' | 'deny' | 'require-approval' {
  if (policy === 'deny') return 'deny';
  if (person.launched && person.grant === 'allow') {
    if (cell === 'mcp-floor' || cell === 'edit-authority') return 'require-approval';
    return policy === 'unmarked' ? 'require-approval' : 'allow';
  }
  if (policy === 'allow') return RAISING.has(cell) ? 'require-approval' : 'allow';
  if (policy === 'unmarked') return 'require-approval';
  const mode = person.entry === null || person.entry.mode === 'full-access' ? 'standart' : person.entry.mode, askEdits = person.entry?.askEdits === true;
  if (cell === 'edit') return askEdits ? 'require-approval' : 'allow';
  if (mode !== 'full-auto') return 'require-approval';
  if (cell === 'shell-narrow-mutating' || cell === 'mcp-call') return 'allow';
  return SANDBOX_CELLS.has(cell) && realm === 'sandbox-contained' ? 'allow' : 'require-approval';
}

function policyFor(cell: AgentToolCallCell, person: Person, policy: Policy) {
  const tool = toolOf(cell), operation = operationOf(cell);
  const effect = policy === 'eligible' || policy === 'unmarked' ? 'require-approval' : policy;
  const rule = (id: string, kind: string, ids: string[], action: string) => ({ id, effect, actions: [action], scopes: ['scope'], principals: [me], resource: { kind, ids },
    ...(policy === 'eligible' ? { modeEligible: true } : {}) });
  const grants: unknown[] = [rule('tool', 'agent-tool', [tool], 'invoke'), ...(operation ? [{ ...rule('op', 'operation', [operation], 'execute') }] : [])];
  if (person.grant) grants.push({ id: 'fa', effect: person.grant, actions: ['set'], scopes: ['scope'], principals: [me], resource: { kind: 'permission-mode', ids: ['full-access'] } });
  return resolvePolicyBindings({ schemaVersion: 2, revision: 'p', roles: [], separationOfDuties: [], restrictions: [], grants },
    { schemaVersion: 3, revision: 'b', bindings: [], modes: person.entry ? [{ id: 'mine', principal: me, scopes: ['scope'], ...person.entry }] : [] });
}

function decide(cell: AgentToolCallCell, realm: Realm, person: Person, policy: Policy) {
  const shell = cell.startsWith('shell') ? { realm: realm === 'degraded' ? 'degraded' as const : realm === 'host' ? 'host' as const : 'sandbox' as const,
    contained: realm === 'sandbox-contained' } : undefined;
  return decideAgentToolCall(policyFor(cell, person, policy), { principal, scopeId: 'scope', tool: { name: toolOf(cell) }, operation: operationOf(cell) ? { id: operationOf(cell)! } : null,
    cell, ...(shell ? { shell } : {}), ...(person.launched ? { fullAccess: true } : {}) });
}

describe('the three permission modes: the whole decision matrix (MODES-3)', () => {
  const rows = CELLS.flatMap(cell => (cell.startsWith('shell') ? REALMS : ['host' as const]).flatMap(realm => PEOPLE.flatMap(person =>
    (['allow', 'eligible', 'unmarked', 'deny'] as const).map(policy => ({ cell, realm, person: person.label, policy, expected: expected(cell, realm, person, policy),
      actual: decide(cell, realm, person, policy) })))));

  it('matches the owner\'s table in every cell, realm, person and company policy', () => {
    const shells = CELLS.filter(cell => cell.startsWith('shell')).length;
    expect(rows.length).toBe((CELLS.length - shells + shells * REALMS.length) * PEOPLE.length * 4);
    expect(rows.filter(row => row.actual.decision !== row.expected).map(row => `${row.cell}/${row.realm}/${row.person}/${row.policy}: ${row.actual.decision} ≠ ${row.expected}`)).toEqual([]);
  });

  it('never lowers a deny in any mode, full access included (a deny always ends the decision)', () => {
    const denied = rows.filter(row => row.policy === 'deny');
    expect(denied.length).toBeGreaterThan(0);
    expect(denied.every(row => row.actual.decision === 'deny' && row.actual.relaxation === null && row.actual.fullAccess === undefined)).toBe(true);
  });

  it('carries the audited reason of every silent lowering: a relaxation in standart/full-auto, a full-access decision for every allowed effect call', () => {
    for (const row of rows.filter(row => row.actual.decision === 'allow')) {
      const person = PEOPLE.find(item => item.label === row.person)!;
      const launched = person.launched && person.grant === 'allow';
      if (launched && row.cell !== 'read') expect({ ...row, full: row.actual.fullAccess }).toMatchObject({ full: { cell: row.cell, grant: 'fa' } });
      else if (launched) expect(row.actual.fullAccess).toBeUndefined();
      else if (row.policy === 'eligible') expect(row.actual.relaxation).toMatchObject({ mode: person.entry?.mode === 'full-auto' ? 'full-auto' : 'standart' });
      else expect(row.actual.relaxation).toBeNull();
    }
  });

  it('keeps the MCP ask pin and the configuration write asking even in full access, and full access only on the launch flag and the grant', () => {
    const launched = PEOPLE.find(person => person.label === 'full-access launched')!;
    for (const cell of ['mcp-floor', 'edit-authority'] as const) for (const policy of ['allow', 'eligible'] as const) expect(decide(cell, 'host', launched, policy).decision).toBe('require-approval');
    const stored = PEOPLE.find(person => person.label === 'stored full-access, not launched')!;
    expect(decide('shell-destructive', 'host', stored, 'eligible').decision).toBe('require-approval');
    expect(decide('shell-destructive', 'host', launched, 'eligible').decision).toBe('allow');
  });

  it('records a full-access fetch by its host and argument digest (never the URL) in a sealed-audit-valid event', () => {
    const launched = PEOPLE.find(person => person.label === 'full-access launched')!;
    const decision = decide('fetch-unlisted', 'host', launched, 'allow');
    const event = agentCallAuditEvent({ eventId: 'e1', scopeId: 'scope', principal, atMs: 1, tool: { name: 'fetch_url', version: 1 },
      call: { turnId: 't', round: 1, index: 0, callId: 'c' }, summary: { kind: 'fetch', host: 'example.com', argsDigest: 'a'.repeat(64) } }, decision);
    expect(auditEventSchema.parse(event).subject).toEqual({ kind: 'full-access-call', cell: 'fetch-unlisted', policy: 'allow', raised: true, company: null, grant: 'fa',
      tool: { name: 'fetch_url', version: 1 }, call: { turnId: 't', round: 1, index: 0, callId: 'c' }, summary: { kind: 'fetch', host: 'example.com', argsDigest: 'a'.repeat(64) } });
    expect(auditEventSchema.safeParse({ ...event, subject: { ...event.subject, summary: { kind: 'fetch', host: 'example.com', url: 'https://example.com/?token=x', argsDigest: 'a'.repeat(64) } } }).success).toBe(false);
  });
});
