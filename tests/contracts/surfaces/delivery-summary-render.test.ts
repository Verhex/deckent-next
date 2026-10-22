import { describe, expect, it } from 'vitest';
import { AUTONOMY_HOLD_REASONS, DELIVERY_MODEL_VERDICTS, DELIVERY_RISK_FLAGS, DELIVERY_SUMMARY_ACTIONS, deliverySummarySchema, queueCommandIds, targetQueueViewSchema,
  type DeliverySummary } from '#engine/index.js';
import { MESSAGE_KEYS } from '#platform/index.js';
import { consentSummaryLines, consentSummaryOperation, queueSummaryRequest, readConsentSummaries, renderAutonomyShadow, renderDeliverySummary, summaryListCells,
  DELIVERY_RENDER_LIMITS } from '#surfaces/core/delivery-summary/index.js';

/** TESLIM-KARTI-OZET renderer (alpha.53 A2): bounded human lines in EN/TR, claims vs system, honest withheld/unavailable, no shadow on the card. */
const identity = { scopeId: 'scope', runId: 'run', layoutRevision: 'layout', taskId: 'task', attemptId: 'attempt', generation: 1 };
const evidence = { evaluator: { id: 'process-exit', version: 1 }, kind: 'exit-code', independent: false } as const;
function summary(patch: Partial<DeliverySummary> = {}): DeliverySummary {
  return deliverySummarySchema.parse({ schemaVersion: 1, operation: 'deliver', subject: identity, target: { state: 'available', id: 'refs/heads/feature', protected: false },
    title: { source: 'work-input', text: 'Login banner fix' }, outcome: { state: 'available', claim: true, summary: 'Banner fixed.', truncated: false },
    acceptance: { verdict: 'accepted', criteriaCount: 2, evidence: [evidence] },
    tests: { worker: { state: 'available', claim: true, passed: 2, failed: 0, notRun: 1, unknown: 0 },
      verification: { state: 'available', runId: 'queue-verify-1', phase: 'accepted', evidence: [evidence] } },
    model: { state: 'available', requested: { channelId: 'channel', modelId: 'model-x' }, verdict: 'verified' },
    risk: { class: 'small', workClass: 'small', protectedTarget: false, sizeBucket: 'tiny', flags: ['evidence-not-independent'] },
    actions: DELIVERY_SUMMARY_ACTIONS.deliver,
    change: { state: 'available', adapter: 'workspace-patch', files: 2, added: 10, removed: 2, topPaths: ['src/a.ts', 'src/b.ts'], topPathsOmitted: 3, scope: 'in-scope', outOfScope: [], outOfScopeCount: 0 },
    ...patch });
}
describe('renderDeliverySummary', () => {
  it('renders the full card in English with claims labelled and the system verification named', () => {
    expect(renderDeliverySummary(summary(), 'en')).toEqual([
      'Work: Login banner fix', 'Deliver this result to refs/heads/feature',
      "Worker's own report (a claim, not checked): Banner fixed.",
      'Changed: 2 files, +10 −2', 'Main paths: src/a.ts, src/b.ts (+3 more)',
      'Accepted · 2 criteria · on: exit code · content not independently verified',
      'Worker-reported checks (claim): 2 passed, 0 failed, 1 not run, 0 unknown',
      'System verification (queue-verify-1): accepted · on: exit code · content not independently verified',
      'Model channel/model-x: verified', 'Risk: small change · size tiny · evidence not independent',
      'Yes: the result is published · No: nothing is published']);
  });
  it('renders Turkish for the same card', () => {
    const lines = renderDeliverySummary(summary(), 'tr');
    expect(lines[0]).toBe('İş: Login banner fix');
    expect(lines).toContain('Kabul edildi · 2 ölçüt · dayanak: ' + lines[5]!.split('dayanak: ')[1]);
    expect(lines.at(-1)).toBe('Evet: sonuç yayımlanır · Hayır: hiçbir şey yayımlanmaz');
    expect(lines[2]).toContain('beyan');
  });
  it('says plainly when sections are withheld or unavailable', () => {
    const lines = renderDeliverySummary(summary({ outcome: { state: 'withheld' }, change: { state: 'withheld' }, model: { state: 'unavailable' },
      title: { source: 'untitled' }, target: { state: 'unavailable' }, tests: { worker: { state: 'unavailable' }, verification: { state: 'withheld' } } }), 'en').join('\n');
    expect(lines).toContain('Work: (no title recorded)'); expect(lines).toContain('the target (not known)');
    expect(lines).toContain('Worker\'s own report: not shown (you may not read it)'); expect(lines).toContain('Changed: not shown (you may not read it)');
    expect(lines).toContain('Model: unknown'); expect(lines).toContain('Worker-reported checks: none recorded'); expect(lines).toContain('System verification: not shown');
    expect(renderDeliverySummary(summary({ change: { state: 'unavailable' } }), 'tr').join('\n')).toContain('Değişen: bilinmiyor');
  });
  it('names out-of-scope paths, unscoped work and unverified acceptance with its flags', () => {
    const lines = renderDeliverySummary(summary({ acceptance: { verdict: 'accepted-unverified', criteriaCount: 0, evidence: [] },
      risk: { class: 'other', workClass: null, protectedTarget: true, sizeBucket: null, flags: ['out-of-scope', 'protected-target'] },
      change: { state: 'available', adapter: 'workspace-patch', files: 1, added: 1, removed: 0, topPaths: ['x.ts'], topPathsOmitted: 0, scope: 'out-of-scope', outOfScope: ['x.ts'], outOfScopeCount: 4 } }), 'en').join('\n');
    expect(lines).toContain('Outside the allowed scope (4): x.ts (+3 more)'); expect(lines).toContain('Accepted, but the content was not independently verified · 0 criteria · on: no evidence recorded');
    expect(lines).toContain('Risk: not a small change · protected target · changes outside scope · protected target');
    expect(renderDeliverySummary(summary({ change: { state: 'available', adapter: 'workspace-patch', files: 1, added: 0, removed: 0, topPaths: [], topPathsOmitted: 0, scope: 'unscoped', outOfScope: [], outOfScopeCount: 0 } }), 'en')).toContain('No scope was declared for this work');
  });
  it('renders every model verdict (incl. start-name-matched and provider-chosen), operation and flag in both locales without unresolved keys or placeholders', () => {
    for (const locale of ['en', 'tr'] as const) {
      for (const verdict of DELIVERY_MODEL_VERDICTS) {
        const text = renderDeliverySummary(summary({ model: { state: 'available', requested: { channelId: 'cursor', modelId: 'm' }, verdict } }), locale).join('\n');
        expect(text).not.toMatch(/\{\w+\}|cli\.worker|delivery\./);
      }
      for (const operation of ['deliver', 'adopt', 'rollback'] as const) {
        const text = renderDeliverySummary(summary({ operation, actions: DELIVERY_SUMMARY_ACTIONS[operation] }), locale).join('\n');
        expect(text).not.toMatch(/\{\w+\}|delivery\./);
      }
      expect(renderDeliverySummary(summary({ risk: { class: 'other', workClass: null, protectedTarget: null, sizeBucket: null, flags: [...DELIVERY_RISK_FLAGS] } }), locale).join('\n')).not.toMatch(/delivery\./);
    }
    const provider = renderDeliverySummary(summary({ model: { state: 'available', requested: { channelId: 'cursor', modelId: 'm' }, verdict: 'provider-chosen' } }), 'en').join('\n');
    expect(provider).toContain('left to the provider (cursor)');
  });
  it('bounds long values, strips terminal control sequences and redacts secrets', () => {
    const lines = renderDeliverySummary(summary({ title: { source: 'work-input', text: 'a\u001b[31mred\u001b[0m' }, outcome: { state: 'available', claim: true, summary: 'x'.repeat(240), truncated: true } }), 'en', { maxLineChars: 80 });
    for (const line of lines) { expect([...line].length).toBeLessThanOrEqual(80); expect(line).not.toContain('\u001b'); }
    expect(lines[2]!.endsWith('…')).toBe(true);
  });
  it('is deterministic and does not mutate the summary', () => {
    const input = summary(); const before = JSON.stringify(input);
    expect(renderDeliverySummary(input, 'en')).toEqual(renderDeliverySummary(input, 'en')); expect(JSON.stringify(input)).toBe(before);
  });
});
describe('renderAutonomyShadow', () => {
  it('renders the would-deliver and would-hold one-liners with every hold reason in both locales', () => {
    expect(renderAutonomyShadow({ verdict: 'would-deliver', reasons: [] }, 'en')).toBe('Rule off · would have delivered');
    expect(renderAutonomyShadow({ verdict: 'would-deliver', reasons: [] }, 'tr')).toBe('Kural kapalı · teslim ederdi');
    expect(renderAutonomyShadow({ verdict: 'would-hold', reasons: ['target-protected', 'size-over-bound'] }, 'tr')).toBe('Kural kapalı · bekletirdi: korumalı hedef, değişiklik çok büyük');
    for (const locale of ['en', 'tr'] as const) expect(renderAutonomyShadow({ verdict: 'would-hold', reasons: AUTONOMY_HOLD_REASONS }, locale, { maxLineChars: 5000 })).not.toMatch(/delivery\.|\{/);
  });
  it('is never part of the card lines (the consent prompt shows the card only)', () => {
    expect(renderDeliverySummary(summary(), 'en').join('\n')).not.toMatch(/Rule off/);
    expect(MESSAGE_KEYS.filter(key => key.startsWith('delivery.shadow.')).length).toBeGreaterThan(0);
  });
});

/** alpha.53 A3: the card helpers every surface shares (request facts, consent block, list cells, brief window lines). */
describe('delivery card helpers (alpha.53 A3)', () => {
  const view = (over: Record<string, unknown> = {}) => targetQueueViewSchema.parse({ schemaVersion: 1, commandId: 'q1', identity, operation: 'delivery',
    target: { kind: 'git-ref', id: 'refs/heads/integration' }, display: { schemaVersion: 1, labelKey: 'queue.git.target', basisKey: 'queue.git.basis', versionKey: 'queue.git.version', prepareActionKey: 'queue.git.prepare' },
    state: 'awaiting-confirmation', outcome: null, revision: 1, observedAt: 1, freshness: 'last-known', position: 1, nextAction: 'confirm-batch', responsibility: 'human',
    basis: { observed: 'o', effective: 'e', candidate: 'c' }, verification: null, evidenceRefs: [], reason: null, ...over });
  it('a queue ticket asks for its own verification Run and the git verdict the ticket already carries (protected / passed preparation / unknown)', () => {
    expect(queueSummaryRequest(view(), 8)).toEqual({ schemaVersion: 1, identity, operation: 'adopt', target: { id: 'refs/heads/integration', protected: false },
      verificationRunId: queueCommandIds({ request: { identity, commandId: 'q1' } } as never).verificationRun, topPaths: 8 });
    expect(queueSummaryRequest(view({ basis: null }), 8).target).toEqual({ id: 'refs/heads/integration', protected: null });
    expect(queueSummaryRequest(view({ basis: null, state: 'settled', outcome: 'target-protected', nextAction: 'select-target' }), 8).target?.protected).toBe(true);
    expect(queueSummaryRequest(view({ operation: 'rollback' }), 8).operation).toBe('rollback');
    expect(queueSummaryRequest(view(), 0, consentSummaryOperation('publish')).operation).toBe('deliver');
    expect(consentSummaryOperation('adopt')).toBe('adopt'); expect(consentSummaryOperation('rollback')).toBe('rollback');
  });
  it('consent summaries keep item order; an unreadable ticket is null; a failed reader degrades to nulls; no paths are asked for', async () => {
    const consent = { operation: 'publish' as const, items: ['q1', 'gone', 'q3'].map(commandId => ({ commandId, from: 'a', to: 'b', candidateDigest: 'c'.repeat(64), verificationReceipt: 'd'.repeat(64), changes: [] })) };
    const asked: unknown[] = [], inspect = async (id: string) => id === 'gone' ? null : view({ commandId: id });
    const read = await readConsentSummaries(consent, inspect, async requests => { asked.push(...requests); return requests.map(request => summary({ title: { source: 'work-input', text: request.verificationRunId! } })); });
    expect(read.map(row => row?.title)).toEqual([{ source: 'work-input', text: queueCommandIds({ request: { identity, commandId: 'q1' } } as never).verificationRun }, undefined,
      { source: 'work-input', text: queueCommandIds({ request: { identity, commandId: 'q3' } } as never).verificationRun }]);
    expect(read[1]).toBeNull(); expect(asked).toMatchObject([{ operation: 'deliver', topPaths: 0 }, { operation: 'deliver', topPaths: 0 }]);
    expect(await readConsentSummaries(consent, inspect, async () => { throw new Error('ledger-gone'); })).toEqual([null, null, null]);
    expect(await readConsentSummaries(consent, async () => { throw new Error('socket'); }, async () => { throw new Error('not-called'); })).toEqual([null, null, null]);
  });
  it('the consent block names what the yes approves, one block per ticket, and has no shadow words', () => {
    expect(consentSummaryLines([], 'en')).toEqual([]);
    const lines = consentSummaryLines([summary(), null], 'tr');
    expect(lines[0]).toBe('Özet (evetiniz yalnızca aşağıdaki kesin kartı onaylar):'); expect(lines[1]).toBe('İş: Login banner fix');
    expect(lines.at(-1)).toBe('Özet: gösterilemez (yetki ya da kayıt yok)'); expect(lines.join('\n')).not.toMatch(/Kural kapalı/u);
  });
  it('a brief block leaves out title, operation and files (the window shows them) but never acceptance, risk or actions', () => {
    const brief = renderDeliverySummary(summary(), 'en', { omit: ['title', 'operation', 'change'] });
    expect(brief.join('\n')).not.toMatch(/Work:|Deliver this result|Changed:|Main paths/u);
    expect(brief[0]).toContain("Worker's own report"); expect(brief.at(-2)).toMatch(/^Risk: /u); expect(brief.at(-1)).toMatch(/^Yes: /u);
  });
  it('list cells: a bounded title, one risk word and the shadow word; a missing summary or shadow is a dash', () => {
    const long = summary({ title: { source: 'work-input', text: 'x'.repeat(80) } }), cells = summaryListCells(long, { verdict: 'would-deliver', reasons: [] }, 'tr');
    expect([...cells.title]).toHaveLength(DELIVERY_RENDER_LIMITS.listTitleChars); expect(cells.title.endsWith('…')).toBe(true);
    expect(cells).toMatchObject({ risk: 'küçük', shadow: 'teslim ederdi' });
    expect(summaryListCells(summary({ risk: { ...summary().risk, class: 'other' } }), { verdict: 'would-hold', reasons: ['size-unknown'] }, 'en')).toMatchObject({ risk: 'other', shadow: 'would hold' });
    expect(summaryListCells(null, null, 'en')).toEqual({ title: '—', risk: '—', shadow: '—' });
  });
});
