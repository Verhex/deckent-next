import { expect, it } from 'vitest';
import { adoptionNotApplied, adoptionVerificationPhaseOutcome, executionProfileFingerprint, integrationAdoptionCommandSchema, type IntegrationAdoptionRecord } from '#engine/index.js';

it('maps every verification task phase to one outcome (design §5.4): only accepted verifies', () => {
  expect({
    accepted: adoptionVerificationPhaseOutcome('accepted'),
    failed: adoptionVerificationPhaseOutcome('failed'),
    pending: adoptionVerificationPhaseOutcome('pending'),
    active: adoptionVerificationPhaseOutcome('active'),
    evaluating: adoptionVerificationPhaseOutcome('evaluating'),
    reconciling: adoptionVerificationPhaseOutcome('reconciling'),
    cancelled: adoptionVerificationPhaseOutcome('cancelled'),
  }).toEqual({ accepted: null, failed: 'ADOPTION_VERIFICATION_FAILED', pending: 'ADOPTION_VERIFICATION_PENDING',
    active: 'ADOPTION_VERIFICATION_PENDING', evaluating: 'ADOPTION_VERIFICATION_PENDING', reconciling: 'ADOPTION_VERIFICATION_UNSETTLED',
    cancelled: 'ADOPTION_VERIFICATION_CANCELLED' });
});

it('fingerprints a profile definition independently of key order and sensitive to every parameter', () => {
  const profile = { id: 'verify', version: 1, adapter: { id: 'docker', version: 1 }, parameters: { argv: ['npm', 'test'], deadlineMs: 1000 } };
  const reordered = { parameters: { deadlineMs: 1000, argv: ['npm', 'test'] }, adapter: { version: 1, id: 'docker' }, version: 1, id: 'verify' };
  expect(executionProfileFingerprint(profile)).toMatch(/^[a-f0-9]{64}$/);
  expect(executionProfileFingerprint(reordered)).toBe(executionProfileFingerprint(profile));
  expect(executionProfileFingerprint({ ...profile, parameters: { ...profile.parameters, argv: ['true'] } })).not.toBe(executionProfileFingerprint(profile));
  expect(executionProfileFingerprint({ ...profile, version: 2 })).not.toBe(executionProfileFingerprint(profile));
});

it('accepts the v2 adoption command with both verification fields or neither, and no v1 command', () => {
  const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', layoutRevision: 'l', generation: 1 };
  const base = { schemaVersion: 2, commandId: 'c', identity, deliveryCommandId: 'd', targetRef: 'refs/heads/main' };
  expect(integrationAdoptionCommandSchema.parse(base)).toEqual(base);
  expect(integrationAdoptionCommandSchema.parse({ ...base, verificationRunId: 'v', verificationKind: 'verify' })).toMatchObject({ verificationRunId: 'v' });
  expect(() => integrationAdoptionCommandSchema.parse({ ...base, verificationRunId: 'v' })).toThrow();
  expect(() => integrationAdoptionCommandSchema.parse({ ...base, verificationKind: 'verify' })).toThrow();
  expect(() => integrationAdoptionCommandSchema.parse({ ...base, schemaVersion: 1 })).toThrow();
});

// Lead decision on BENIMSEME-DEPO-KIMLIGI: every Deckent branch move claims its journal row first (and a target with a queue generation
// refuses unfenced adoption), so a ticket with no row was never moved by Deckent, whatever the tip shows now.
it('no journal row means not applied whatever the tip; a recorded intent keeps every other guard', () => {
  const [from, moved] = ['a'.repeat(40), 'b'.repeat(40)], repository = 'r'.repeat(64);
  const observed = (tip: string | null, fence: { sequence: number; scopeId: string; commandId: string } | null = null) => ({ tip, checkedOut: false, fence, repository });
  const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: 'l' };
  const record = (fields: Partial<IntegrationAdoptionRecord> = {}): IntegrationAdoptionRecord => ({ sequence: 2, settled: false, repository, ...fields,
    intent: { schemaVersion: 2, kind: 'adopt', command: { schemaVersion: 2, commandId: 'c', identity, deliveryCommandId: 'd', targetRef: 'refs/heads/x' },
      targetRef: 'refs/heads/x', fromCommit: from, toCommit: moved, deliveryRef: `refs/deckent/deliveries/${'c'.repeat(64)}`, basis: 'task-acceptance',
      acceptance: { runRevision: 1 }, verification: null, actor: { id: 'h', issuer: 'os', subject: '1' } } });
  expect([adoptionNotApplied(observed(from), null, from), adoptionNotApplied(observed(moved), null, from), adoptionNotApplied(observed(null), null, from)])
    .toEqual([true, true, true]);
  expect({
    unsettled: adoptionNotApplied(observed(from), record(), from),
    moved: adoptionNotApplied(observed(moved), record(), from),
    ownFence: adoptionNotApplied(observed(from, { sequence: 2, scopeId: 's', commandId: 'c' }), record(), from),
    settled: adoptionNotApplied(observed(from), record({ settled: true }), from),
    otherRepository: adoptionNotApplied(observed(from), record({ repository: 'o'.repeat(64) }), from),
    otherBase: adoptionNotApplied(observed(moved), record(), moved),
  }).toEqual({ unsettled: true, moved: false, ownFence: false, settled: false, otherRepository: false, otherBase: false });
  // Astra 2616 F1: a pre-v58 intent recorded no repository. Only independent evidence of the claiming repository (a queue ticket's target
  // binding, current or pre-QUEUE-SMALL 2 formula) attributes it; another repository's base/no-fence state proves nothing.
  const legacy = { ...observed(from), legacyBinding: 'l'.repeat(64) };
  expect({
    noEvidence: adoptionNotApplied(observed(from), record({ repository: null }), from),
    claimedHere: adoptionNotApplied(observed(from), record({ repository: null }), from, repository),
    claimedHereBeforeQueueSmall: adoptionNotApplied(legacy, record({ repository: null }), from, 'l'.repeat(64)),
    claimedElsewhere: adoptionNotApplied(legacy, record({ repository: null }), from, 'o'.repeat(64)),
    recordedWins: adoptionNotApplied(observed(from), record({ repository: 'o'.repeat(64) }), from, repository),
  }).toEqual({ noEvidence: false, claimedHere: true, claimedHereBeforeQueueSmall: true, claimedElsewhere: false, recordedWins: false });
});
