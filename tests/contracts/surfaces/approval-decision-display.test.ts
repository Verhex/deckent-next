import { panelFixture } from '../support/workline-panel-fixture.js';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createElement } from 'react';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { redactForDecision, snapshotKnownSecrets } from '#platform/index.js';
import type { RunView } from '#engine/index.js';
import { plainText } from '#surfaces/core/terminal-render/index.js';
import { terminalRenderLabels } from '#surfaces/core/terminal-labels/index.js';
import { appendLedger, compactLedger, EMPTY_LEDGER, buildWorklineBridgeSnapshot, ledgerEntrySummary,
  WorklineApp, WorklinePaletteProvider, resolveWorklinePalette, type WorklineApproval, type WorklineProps } from '#surfaces/core/terminal/index.js';
import { approvalSummarySpans, projectApprovalDecisionText, approvalTemplateLine, assembleApprovalCard } from '#surfaces/core/approval-presentation/index.js';
import { WORKLINE_TEST_LABELS, mountWorkline, settle, until } from '../support/workline-harness.js';

const SECRET = 'fictitious-known-0123456789';
const known = snapshotKnownSecrets([{ name: 'FIXTURE_ONLY', value: SECRET }]);
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const mounted: Array<{ unmount(): void }> = [];
afterEach(() => { for (const instance of mounted.splice(0)) instance.unmount(); });
/** The approval window's EN deny key hint (T-APPROVAL-WINDOW): present exactly while a decision window owns the keyboard. */
const DENY = 'n deny (Enter/Esc too)';
const frames: Array<{ label: string; frame: string }> = [];
afterAll(() => { if (process.env.DECKENT_A1_FRAME_PROOF) writeFileSync(process.env.DECKENT_A1_FRAME_PROOF, JSON.stringify({ syntheticFixturesOnly: true, frames }, null, 2) + '\n'); });
const observe = (label: string, view: ReturnType<typeof mountWorkline>) => { frames.push({ label, frame: view.stdout.frame }); };
const approval = (id: string, summary: string, patch: Partial<WorklineApproval> = {}): WorklineApproval => ({
  approvalId: id, runId: 'run-fixture', taskId: 'task-fixture', requester: 'fixture-user', revision: 7,
  status: 'pending', decision: null, expiresAt: Date.now() + 600_000, summary, ...patch,
});
const labels = (locale: 'en' | 'tr' = 'en') => ({ ...WORKLINE_TEST_LABELS, render: terminalRenderLabels(locale) });
type DecisionTarget = Pick<WorklineApproval, 'approvalId' | 'revision' | 'decisionCapability'>;
const decisions: Array<{ approval: DecisionTarget; decision: string }> = [];
function ledger(items: readonly WorklineApproval[], decide?: (item: DecisionTarget, answer: 'allow' | 'deny') => Promise<WorklineApproval>) {
  return { scopeId: 'fixture-scope', async listWorkers() { return { schemaVersion: 1, scopeId: 'fixture-scope', sources: [] } as never; },
    async inspectRun() { return null; }, async listApprovalPage() { return { items, nextAfter: null }; },
    async decideApproval(item: DecisionTarget, answer: 'allow' | 'deny') {
      decisions.push({ approval: item, decision: answer });
      const original = items.find(candidate => candidate.approvalId === item.approvalId)!;
      return decide ? decide(item, answer) : { ...original, revision: item.revision + 1, status: 'decided' as const, decision: answer };
    } };
}
async function type(view: ReturnType<typeof mountWorkline>, text: string) {
  for (const char of text) { view.stdin.write(char); await settle(2); }
}
function mount(props: Partial<WorklineProps>, width = 220) {
  const view = mountWorkline({ labels: labels(), pollMs: 10_000, ...props }, width); mounted.push(view.instance); return view;
}
/** SLASH-WINDOWS (SW-2): `/approvals` and `/cancel` take no typed reference; the card opens from the command's picker (first row). */
async function pickFirst(view: ReturnType<typeof mountWorkline>, command: '/approvals' | '/cancel', row: string, label: string) {
  await type(view, `${command}\r`); await until(() => view.stdout.frame.includes(row), `${label} picker`);
  await view.instance.waitUntilRenderFlush(); await settle(40); view.stdin.write('\r');
}
function deferred() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function duplicateWhilePending(view: ReturnType<typeof mountWorkline>, entered: () => boolean, pendingText: string) {
  view.stdin.write('y'); await until(() => entered() && view.stdout.frame.includes(pendingText), 'first callback entered and pending');
  view.stdin.write('y'); await until(() => view.stdin.readableLength === 0, 'distinct second key consumed'); await view.instance.waitUntilRenderFlush();
}
describe('A1 complete-field decision projection and private custody', () => {
  it('no_double_projection: unknown credential-shaped command and operators stay visible with canonical raw counters', () => {
    const raw = 'token=fictitious-unknown-value; rm -rf ./fixture && echo next';
    const result = projectApprovalDecisionText(raw, known);
    expect(plainText(result.spans)).toBe(raw);
    expect(result.patternMatches).toEqual(redactForDecision(raw, known).patternMatches);
    expect(result.patternMatches.some(match => match.count > 0)).toBe(true);
  });

  it('fallback_known160_and_upstream199: complete local field protects a crossing secret without claiming a lost upstream tail', () => {
    const raw = 'x'.repeat(154) + SECRET + '; echo fixture', before = hash(raw);
    const display = plainText(approvalSummarySpans(projectApprovalDecisionText(raw, known)));
    expect(display).not.toContain(SECRET); expect(display).not.toContain('ficti'); expect(display).toContain('…');
    expect(hash(raw)).toBe(before);
    // Upstream clipping is a real contrary boundary: a lost suffix is not repaired by this local display adapter.
    const upstream = ('x'.repeat(194) + SECRET).slice(0, 199);
    expect(plainText(projectApprovalDecisionText(upstream, known).spans)).toContain('ficti');
  });

  it('exact_fe_ff_before_collapse: numeric markers survive and a look-alike literal adds no count', () => {
    const result = projectApprovalDecisionText('fixture\uFEFF summary\u200B \u{E0061}end<U+200B>');
    expect(result.hiddenCount).toBe(3);
    expect(result.spans.filter(part => part.hiddenCodePoint !== undefined).map(part => part.hiddenCodePoint)).toEqual([0xFEFF, 0x200B, 0xE0061]);
    expect(plainText(approvalSummarySpans(result))).toContain('<U+FEFF>');
    expect(result.spans.filter(part => part.hiddenCodePoint === 0x200B)).toHaveLength(1);
    const edge = projectApprovalDecisionText('x'.repeat(155) + '\u200B');
    expect(plainText(approvalSummarySpans(edge))).toBe('x'.repeat(155) + '…');
    expect(edge.hiddenCount).toBe(1);
  });

  it('original_and_reconstructed_known: decision guards both control reconstruction and original known control bytes', () => {
    for (const control of ['\u0000', '\u001b[31m']) {
      const raw = SECRET.slice(0, 12) + control + SECRET.slice(12);
      const result = projectApprovalDecisionText(raw, known);
      expect(plainText(result.spans)).toBe('‹secret:FIXTURE_ONLY›');
      expect(result.patternMatches).toEqual(redactForDecision(raw, known).patternMatches);
    }
    const controlSecret = snapshotKnownSecrets([{ name: 'CONTROL_FIXTURE', value: 'fixture\u0000knownvalue' }]);
    expect(plainText(projectApprovalDecisionText('fixture\u0000knownvalue', controlSecret).spans)).toBe('‹secret:CONTROL_FIXTURE›');
    const unknown = 'Bearer fictitious-unknown-value\u001b[31m', result = projectApprovalDecisionText(unknown, known);
    expect(plainText(result.spans)).toBe('Bearer fictitious-unknown-value');
    expect(result.patternMatches).toEqual(redactForDecision(unknown, known).patternMatches);
    expect(result.patternMatches.some(match => match.count > 0)).toBe(true);
    expect(redactForDecision(plainText(result.spans), known).patternMatches.some(match => match.count > 0)).toBe(true);
  });

  it('public_ledger_identity_contract: append/compaction and serialized placeholder preserve the existing public shape', () => {
    const entry = Object.freeze({ schemaVersion: 1 as const, kind: 'notice' as const, id: 'notice', level: 'info' as const, text: 'SAFE-TITLE' });
    const buffer = compactLedger(appendLedger(EMPTY_LEDGER, [entry]), 1, 1);
    expect(buffer.tail[0]).toBe(entry); expect(ledgerEntrySummary(entry)).toBe('SAFE-TITLE');
    expect(JSON.parse(JSON.stringify(entry))).toEqual(entry);
    // This public-port check does not prove private WeakMap clones; no getter is exposed just for a test.
  });

  it('unrelated_record_notice: actual generic opening notice masks while a decision field stays visible', async () => {
    const raw = 'token=fictitious-record-value';
    const view = mount({ openingNotices: [{ level: 'info', text: raw }], ledger: ledger([approval('fixture', raw)]) });
    await until(() => view.stdout.frame.includes('[REDACTED]'), 'generic record notice');
    expect(view.stdout.frame).not.toContain('fictitious-record-value');
    await pickFirst(view, '/approvals', '> A-ITEM 1', 'decision card'); await until(() => view.stdout.frame.includes(DENY), 'decision card');
    expect(view.stdout.frame).toContain(raw);
  });

  it('no_snapshot_and_changed_snapshot: the same mounted actual Provider child reprojects only its current snapshot', async () => {
    const item = approval('snapshot-fixture', SECRET), props: WorklineProps = { context: { installationId: 'fixture-installation', projectId: 'fixture-project', scopeId: 'scope-a' }, labels: labels(), target: 'scope · model', systemPrompt: 'SYSTEM', historyMessages: 40,
      errorText: error => `ERR:${(error as Error).message}`, completeTurn: async () => 'unused', pollMs: 10_000, ledger: ledger([item]) };
    // A current dynamic card can reproject; an already printed Static row is historical output and cannot be retracted.
    const view = mount(props); await type(view, '/approvals\r'); await until(() => view.stdout.frame.includes('> A-ITEM 1 snapshot-fixture'), 'snapshot picker');
    await view.instance.waitUntilRenderFlush(); view.stdin.write('\r'); await until(() => view.stdout.frame.includes(DENY), 'snapshot card');
    expect(view.stdout.frame).toContain(SECRET); observe('snapshot-none-initial', view);
    for (const snapshot of [known, snapshotKnownSecrets([{ name: 'OTHER_FIXTURE', value: 'unrelated-known-value' }]), undefined]) {
      view.instance.rerender(createElement(WorklinePaletteProvider, { palette: resolveWorklinePalette('none'), children: createElement(WorklineApp, { ...props, ...panelFixture(props), ...(snapshot ? { knownSecrets: snapshot } : {}) }) }));
      const expected = snapshot === known ? '‹secret:FIXTURE_ONLY›' : SECRET;
      await until(() => view.stdout.frame.includes(DENY) && view.stdout.frame.includes(expected), 'same mounted snapshot update');
      expect(item.summary).toBe(SECRET); if (snapshot === known) expect(view.stdout.frame).not.toContain(SECRET);
      observe(snapshot === known ? 'snapshot-matching' : snapshot ? 'snapshot-unrelated' : 'snapshot-removed', view);
    }
  });

  it('bridge_and_persistence_fences: summaries/serialized bridge contain only placeholders and Workline saves model history separately', async () => {
    const entry = { schemaVersion: 1 as const, kind: 'notice' as const, id: 'notice', level: 'info' as const, text: 'SAFE-TITLE' };
    // Private A1 bridge/clone raw custody is source-trace only: Workline exposes no ledger-tail observer or raw notice injection.
    expect(ledgerEntrySummary(entry)).toBe('SAFE-TITLE');
    const snapshot = buildWorklineBridgeSnapshot({ profile: { id: 'fx', model: { modelId: 'fx-model' } } as never,
      plan: { openaiBaseUrl: 'http://localhost:1' } as never, tty: { columns: 80, rows: 24 }, ledgerTail: [entry], observedAtMs: 1 });
    expect(snapshot.ledgerTail[0]).toBe(entry); expect(JSON.stringify(snapshot)).not.toContain(SECRET);
    const saved: unknown[] = [], model: unknown[] = [];
    const view = mount({ knownSecrets: known, ledger: ledger([approval('fixture', SECRET)]),
      sessions: { async save(value) { saved.push(value); }, async list() { return []; }, async load() { return null; } },
      async completeTurn(messages) { model.push(messages); return 'fixture answer'; } });
    // SW-2: a typed reference is refused in a window that never echoes it; Esc closes it into one system line.
    await type(view, '/approvals missing\r'); await until(() => view.stdout.frame.includes('without arguments'), 'typed reference refused');
    expect(view.stdout.frame).not.toContain('missing'); await settle(40); view.stdin.write('\u001b'); await settle(60);
    await type(view, 'hello\r'); await until(() => saved.length === 1, 'saved ordinary conversation');
    expect(JSON.stringify(saved)).not.toContain(SECRET); expect(JSON.stringify(model)).not.toContain(SECRET);
    expect(JSON.stringify(saved)).not.toContain('without arguments');
  });
});

describe('A1 actual Workline pending ledger -> picker/modal/static fallback', () => {
  it('fallback_existing_numeric: raw command stays in both fallback and modal while the original DTO drives one decision', async () => {
    const raw = 'token=fictitious-untrusted-value; rm -rf ./fixture && echo next', item = approval('real-id', raw);
    const before = hash(item.summary), start = decisions.length, gate = deferred();
    const view = mount({ knownSecrets: known, ledger: ledger([item], async () => { await gate.promise; return { ...item, status: 'decided', decision: 'allow' }; }) });
    await pickFirst(view, '/approvals', '> A-ITEM 1', 'numeric card'); await until(() => view.stdout.frame.includes(DENY), 'numeric card'); await settle(40);
    expect(view.stdout.frame).toContain(raw); expect(view.stdout.text).toContain('A-ITEM 1 real-id');
    expect(view.stdout.frame).toContain('Credential-like matches: 1');
    observe('pending-numeric-unknown-command', view);
    await duplicateWhilePending(view, () => decisions.length > start, 'A-PENDING'); observe('approval-inflight-duplicate', view);
    expect(decisions.slice(start)).toEqual([{ approval: item, decision: 'allow' }]); expect(hash(item.summary)).toBe(before);
    gate.release(); await until(() => !view.stdout.frame.includes('A-PENDING'), 'single approval settled');
  });

  it('fallback_existing_full_id: masks the complete crossing summary before local160cut and preserves whole modal binding/risk/covers', async () => {
    const summary = 'x'.repeat(154) + SECRET + '; echo fixture', item = approval('full-id', summary, { risk: 'fixture-risk', undo: 'fixture-undo' });
    const view = mount({ knownSecrets: known, ledger: ledger([item]) });
    await pickFirst(view, '/approvals', '> A-ITEM 1', 'full-id card'); await until(() => view.stdout.frame.includes(DENY), 'full-id card');
    expect(view.stdout.frame).not.toContain(SECRET); expect(view.stdout.frame).toContain('‹secret:FIXTURE_ONLY›');
    expect(view.stdout.text).not.toContain('ficti'); expect(view.stdout.frame).toMatch(/Risk: +not classified by the tool/u); expect(view.stdout.frame).toContain('Policy cell: fixture-risk'); expect(view.stdout.frame).toContain('Compensating operation: fixture-undo');
    const covers = 'x'.repeat(220) + ' && echo \u200B' + SECRET;
    const safe = projectApprovalDecisionText(covers, known), line = approvalTemplateLine('COVERS {pattern}', { pattern: safe });
    const lines = assembleApprovalCard({ subject: null, summary: projectApprovalDecisionText(summary, known), risk: approvalTemplateLine('RISK', {}),
      preview: null, previewMore: 'MORE {count}', covers: line, expiry: approvalTemplateLine('EXPIRY', {}), assurance: null });
    expect(lines.map(line => plainText(line.spans)).join('\n')).toContain('COVERS ' + 'x'.repeat(220));
    expect(lines.map(line => plainText(line.spans)).join('\n')).toContain('<U+200B>‹secret:FIXTURE_ONLY›');
    expect(item.summary).toBe(summary);
  });

  it('fallback_notfound: a typed reference with hidden characters is refused in a window that never shows it, and decides nothing (SW-2)', async () => {
    const ref = 'missing\u200B\u{E0061}<U+200B>', start = decisions.length, view = mount({ ledger: ledger([approval('one', 'fixture command')]) });
    await type(view, `/approvals ${ref}\r`); await until(() => view.stdout.frame.includes('without arguments'), 'typed reference refused');
    // The window and the screen under it (the composer was emptied on Enter) never show the typed reference or its hidden characters.
    expect(view.stdout.frame).not.toContain('missing'); expect(view.stdout.frame).not.toContain('\u200B'); expect(view.stdout.text).not.toContain('A-NOTFOUND');
    expect(decisions.length).toBe(start);
    observe('pending-notfound-refused', view);
  });

  it('single_y_stale_refusal: picker Down/Enter keeps the original id/revision/capability and typed refusal permits a subsequent deny', async () => {
    const first = approval('first', 'first command'), second = approval('second', 'second\u200B command', { decisionCapability: 'Q'.repeat(43) });
    const seen: Array<{ item: DecisionTarget; answer: string }> = [], gate = deferred();
    const view = mount({ ledger: ledger([first, second], async (item, answer) => {
      seen.push({ item, answer }); if (answer === 'allow') { await gate.promise; throw Object.assign(new Error('APPROVAL_ASSURANCE_INSUFFICIENT'), { code: 'APPROVAL_ASSURANCE_INSUFFICIENT' }); }
      return { ...second, status: 'decided', decision: 'deny' };
    }) });
    await type(view, '/approvals\r'); await until(() => view.stdout.frame.includes('> A-ITEM 1 first'), 'picker'); await settle(40);
    view.stdin.write('\u001b[B'); view.stdin.write('\r'); await until(() => view.stdout.frame.includes('Approval: second'), 'selected second card'); await settle(40);
    expect(view.stdout.frame).toContain('second<U+200B> command'); expect(view.stdout.frame).not.toContain('Q'.repeat(43));
    observe('picker-down-enter-original-row', view);
    await duplicateWhilePending(view, () => seen.length === 1, 'A-PENDING'); expect(seen).toEqual([{ item: second, answer: 'allow' }]); observe('approval-refusal-inflight-duplicate', view);
    // SW-2: the typed refusal is its own window; Esc returns to the same card (the original row), which can still be denied.
    gate.release(); await until(() => view.stdout.frame.includes('ERR:APPROVAL_ASSURANCE_INSUFFICIENT'), 'typed refusal window'); await settle(40);
    view.stdin.write('\u001b'); await until(() => view.stdout.frame.includes(DENY) && view.stdout.frame.includes('Approval: second'), 'typed refusal remount'); await settle(40);
    expect(seen).toEqual([{ item: second, answer: 'allow' }]);
    view.stdin.write('\u001b'); await until(() => seen.length === 2, 'deny after refusal');
    expect(seen).toEqual([{ item: second, answer: 'allow' }, { item: second, answer: 'deny' }]);
    expect(seen[0]!.item).toBe(second); expect(seen[0]!.item.revision).toBe(7);
  });

  it.each(['en', 'tr'] as const)('locale_width_count: %s actual provider child counts at60/80/120cells without treating fake text as metadata', async locale => {
    for (const width of [60, 80, 120]) {
      const item = approval('width-fixture', 'echo \uFEFF\u200B\u{E0061}<U+200B>; token=fictitious-unknown-value');
      const view = mount({ labels: labels(locale), ledger: ledger([item]) }, width);
      await type(view, '/approvals\r'); await until(() => view.stdout.frame.includes('width-fixture'), `picker ${locale}/${width}`); await settle(40);
      const hidden = locale === 'en' ? '3 hidden characters' : '3 gizli karakter';
      const pattern = locale === 'en' ? 'Credential-like matches: 1' : 'Kimlik bilgisi benzeri eşleşme: 1';
      expect(view.stdout.frame).toContain(hidden); expect(view.stdout.frame).toContain(pattern);
      expect(view.stdout.frame).not.toContain('\uFEFF'); expect(view.stdout.frame).not.toContain('\u200B');
      view.stdin.write('\r'); await until(() => view.stdout.frame.includes(DENY), `card ${locale}/${width}`);
      expect(view.stdout.frame).toContain(hidden); expect(view.stdout.frame).toContain(pattern);
      expect(view.stdout.frame).toContain('<U+FEFF>');
    }
  });
});

describe('A1 cancellation private projection -> public completed card', () => {
  it('cancel_known_guard_and_once: complete title/detail projection protects reconstructed known bytes and preserves original cancellation binding', async () => {
    const runId = `run-${SECRET.slice(0, 12)}\u0000${SECRET.slice(12)}\u200B`, scopeId = `${SECRET}\uFEFF`;
    // SW-2: the cancel picker offers only runs that can still be cancelled, so this run has no earlier cancellation request.
    const original = { runId, scopeId, revision: 19, cancellationRequested: false, tasks: [{ phase: 'active\u{E0061}<U+200B>' }] } as unknown as RunView;
    const before = hash(JSON.stringify(original)), seen: Array<[string, number]> = [];
    const gate = deferred();
    const work = { ...WORKLINE_TEST_LABELS.work!, cancelDetail: 'C-DETAIL {revision} {scope} {phases}' };
    const view = mount({ knownSecrets: known, labels: { ...labels(), work }, ledger: { ...ledger([]), async listRunIds() { return [runId]; }, async inspectRun() { return original; },
      async cancelRun(id, revision) { seen.push([id, revision]); await gate.promise; return 'C-OUTCOME'; } } });
    await pickFirst(view, '/cancel', '> ', 'cancellation'); await until(() => view.stdout.frame.includes('C-PROMPT'), 'private cancellation child'); await settle(40);
    expect(view.stdout.frame).toContain('C-TITLE run-‹secret:FIXTURE_ONLY›<U+200B>');
    expect(view.stdout.frame).toContain('C-DETAIL 19 ‹secret:FIXTURE_ONLY›<U+FEFF> active<U+E0061><U+200B>:1');
    expect(view.stdout.frame).not.toContain(SECRET);
    expect(view.stdout.frame).not.toContain('\u0000'); expect(view.stdout.frame).not.toContain('\u200B');
    observe('cancel-known-reconstruction-markers', view);
    await duplicateWhilePending(view, () => seen.length === 1, 'C-PENDING'); observe('cancel-known-inflight-duplicate', view);
    expect(seen).toEqual([[runId, 19]]); expect(hash(JSON.stringify(original))).toBe(before);
    gate.release(); await until(() => view.stdout.frame.includes('C-OUTCOME') && !view.stdout.frame.includes('C-PROMPT'), 'unchanged cancellation outcome');
  });

  it('cancel_unknown_visible_no_snapshot: unknown credential-shaped title stays visible with exact markers and N/remount/y preserve revision', async () => {
    const runId = 'token=fictitious-cancel-value;echo-next\u200B<U+200B>', original = { runId, scopeId: 'fixture-scope', revision: 23,
      cancellationRequested: false, tasks: [{ phase: 'active' }] } as unknown as RunView;
    const seen: Array<[string, number]> = [], gate = deferred(), view = mount({ ledger: { ...ledger([]), async listRunIds() { return [runId]; }, async inspectRun() { return original; },
      async cancelRun(id, revision) { seen.push([id, revision]); await gate.promise; return 'C-OUTCOME'; } } });
    await pickFirst(view, '/cancel', '> ', 'unknown cancellation'); await until(() => view.stdout.frame.includes('C-PROMPT'), 'unknown cancellation card'); await settle(40);
    expect(view.stdout.frame).toContain('C-TITLE token=fictitious-cancel-value;echo-next<U+200B><U+200B>');
    expect(view.stdout.frame).toContain('1 hidden characters'); expect(view.stdout.frame).not.toContain('2 hidden characters');
    expect(view.stdout.frame).toContain('Credential-like matches: 1'); view.stdin.write('n');
    await until(() => !view.stdout.frame.includes('C-PROMPT'), 'cancellation kept'); expect(seen).toEqual([]); await settle(60);
    await pickFirst(view, '/cancel', '> ', 'remount'); await until(() => view.stdout.frame.includes('C-PROMPT'), 'same original cancellation remount');
    await duplicateWhilePending(view, () => seen.length === 1, 'C-PENDING'); observe('cancel-unknown-remounted-inflight-duplicate', view);
    expect(seen).toEqual([[runId, 23]]); expect(original.runId).toBe(runId); expect(original.revision).toBe(23);
    gate.release(); await until(() => !view.stdout.frame.includes('C-PENDING'), 'remounted cancellation settled');
  });
});
