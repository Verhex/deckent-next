import { expect, it } from 'vitest';
import { NERVOUS_HOLD_CODES, RECOVERY_ESCALATION_CODES, createRun, holdRun, nervousHoldNote, readRunHoldNote, recoveryHoldNote, reserveRunTasks } from '#domain/index.js';
import { deriveRunBlocker, projectRunView, recoveryModeState } from '#engine/index.js';
import { renderRunInspect, runControlFlow } from '#surfaces/core/cli-run/index.js';
import { holdNoteText, recoveryStateLines, runHoldNextText, runHoldReasonText } from '#surfaces/core/recovery-text/index.js';
import { runDetailLines } from '#surfaces/core/terminal-work/index.js';
import { workSurfaceLabels } from '#surfaces/core/work-labels/index.js';
import { blockerDetailText } from '#surfaces/core/monitor/index.js';
import { mapBlocks } from '#surfaces/core/monitor-view/index.js';
import { doctorChecks } from '#surfaces/core/doctor/index.js';
import { fixtureExecution } from '../support/execution-registry.js';

// S6R-6 (S6R-DESIGN §13 row S6R-6; lead item 1): a recovery or Nervous safety hold reaches a person only as EN/TR catalog text through the one
// shared renderer — in run inspect, the terminal /runs detail, the monitor and the resume cards — never as its raw code. An operator's own words stay theirs.
const CASE = 'abcdef0123456789'.repeat(4), REF = CASE.slice(0, 12);
const RAW = /(recovery|nervous):[a-z-]+/u;

it('every recovery escalation code and every Nervous hold code has its own EN and TR words, with the case reference and no raw code', () => {
  const notes = [...RECOVERY_ESCALATION_CODES.map(code => recoveryHoldNote(code, CASE)), ...NERVOUS_HOLD_CODES.map(code => nervousHoldNote(code, 'launcher-dead-orphan', CASE))];
  expect(notes).toHaveLength(RECOVERY_ESCALATION_CODES.length + NERVOUS_HOLD_CODES.length);
  const seen = new Set<string>();
  for (const note of notes) {
    expect(readRunHoldNote(note).kind, note).not.toBe('system');
    const en = holdNoteText(note, 'nervous', 'en'), tr = holdNoteText(note, 'nervous', 'tr');
    for (const text of [en, tr]) { expect(text, note).not.toMatch(RAW); expect(text, note).toContain(REF); expect(text).not.toMatch(/\{[a-z]+\}/u); }
    expect(en).not.toBe(tr); expect(tr).toContain('vaka'); seen.add(en);
  }
  expect(seen.size).toBe(notes.length); // one sentence per code, never a shared fallback
});

it('an operator\'s own note is shown as written (even one that looks coded); a system note of an unknown code is a generic safety hold, never raw', () => {
  expect(holdNoteText('waiting for the auditor', 'operator', 'en')).toBe('waiting for the auditor');
  expect(holdNoteText(recoveryHoldNote('effects-open', CASE), 'operator', 'en')).toBe(`recovery:effects-open:${REF}`);
  for (const note of [`recovery:future-code:${REF}`, 'nervous:hold-run:bad rule:x', 'recovery:effects-open']) {
    const text = holdNoteText(note, 'nervous', 'en');
    expect(text, note).toContain('safety system held this Run'); expect(text, note).not.toMatch(RAW);
  }
  expect(holdNoteText(`recovery:future-code:${REF}`, 'nervous', 'tr')).toContain(REF);
});

const graph = { schemaVersion: 4, revision: 1, tasks: [{ id: 'a', kind: 'custom', dependencies: [], acceptanceCriteria: ['verified'] }],
  criterionDefinitions: [{ id: 'verified', version: 1, description: 'Verify', evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }] };
const identity = { runId: 'r', scopeId: 's', layoutRevision: 'l' };
function heldRun(note: string, source: 'operator' | 'nervous' = 'nervous') {
  const reserved = reserveRunTasks(createRun(identity, graph, 1, fixtureExecution(graph)), 0, [{ ...identity, taskId: 'a', attemptId: 'a1', generation: 1 }], 1);
  return holdRun(reserved, reserved.revision, note, 5, 1000, source);
}
const lines = (rows: readonly { spans: readonly { text: string }[] }[]) => rows.map(row => row.spans.map(item => item.text).join('')).join('\n');

it('run inspect, the terminal /runs detail and the monitor blocker show the hold in words with the next step; the raw code appears nowhere', () => {
  const snapshot = heldRun(recoveryHoldNote('continuation-not-approved', CASE)), view = projectRunView(snapshot);
  for (const locale of ['en', 'tr'] as const) {
    const inspect = renderRunInspect({ run: view, models: [] }, locale, false);
    expect(inspect).toContain(holdNoteText(recoveryHoldNote('continuation-not-approved', CASE), 'nervous', locale));
    expect(inspect).toContain(runHoldNextText(view.state, locale)!);
    expect(inspect).not.toMatch(RAW);
    const detail = lines(runDetailLines(view, workSurfaceLabels(locale)));
    expect(detail).toContain(runHoldReasonText(view.state, locale)!); expect(detail).not.toMatch(RAW);
  }
  expect(renderRunInspect({ run: view, models: [] }, 'en', false)).toContain('Automatic continuation after a lost worker is not approved here');
  const blocker = deriveRunBlocker({ run: { snapshot, attempts: [], approvals: [] }, observedAt: 6 } as never)!;
  expect(blocker).toMatchObject({ code: 'parked', detail: `recovery:continuation-not-approved:${REF}` }); // typed detail, rendered by the view
  expect(blockerDetailText(blocker.detail!, 'en')).toContain('not approved here'); expect(blockerDetailText(blocker.detail!, 'tr')).toContain('kalıcı onay yok');
  // An operator's hold keeps its typed reason as the monitor detail and its own words in inspect (no system next step).
  const own = heldRun('auditor asked', 'operator');
  expect(deriveRunBlocker({ run: { snapshot: own, attempts: [], approvals: [] }, observedAt: 6 } as never)).toMatchObject({ detail: 'operator-hold' });
  expect(runHoldNextText(projectRunView(own).state, 'en')).toBeNull();
  expect(renderRunInspect({ run: projectRunView(own), models: [] }, 'en', false)).toContain('Hold: auditor asked');
});

it('the CLI resume card names why the Run is held in words before the person confirms', async () => {
  const view = projectRunView(heldRun(nervousHoldNote('termination-required', 'launcher-dead-orphan', CASE)));
  const asked: { body?: readonly string[] }[] = [], printed: string[] = [];
  const context = { async inspectRun() { return { schemaVersion: 1, layout: {}, run: view }; }, async applyRunLifecycle() { throw new Error('not confirmed'); } };
  await runControlFlow('resume', context as never, { locale: 'en', root: '/nonexistent', options: { env: {} }, ask: (async (card: { body?: readonly string[] }) => { asked.push(card); return 'no'; }) as never,
    print: text => printed.push(text) }, { scopeId: 's', runId: view.runId });
  const body = asked[0]!.body!.join('\n');
  expect(body).toContain('Held because: The safety system held this Run: there is no proof the lost worker stopped');
  expect(body).toContain(REF); expect(body).not.toMatch(RAW);
});

it('the recovery state line (doctor, monitor map) names both protected modes, the grant and its meaning; live without the grant is a person', () => {
  const state = (recovery: 'off' | 'shadow' | 'live', grant: 'present' | 'missing' | 'partial' | 'unknown') => recoveryModeState({ nervous: 'live', recovery }, grant);
  expect(state('live', 'present').continuation).toBe('automatic'); expect(state('live', 'missing').continuation).toBe('person');
  expect(state('shadow', 'missing').continuation).toBe('recorded'); expect(state('off', 'present').continuation).toBe('none');
  expect(recoveryStateLines(state('live', 'missing'), 'en')).toEqual(['Lost-worker recovery: safety system live · recovery live · standing grant missing',
    'Without the standing grant every lost-worker case goes to a person.']);
  expect(recoveryStateLines(state('live', 'present'), 'tr')[0]).toContain('kalıcı onay var');
  const install = { id: 'current', path: '/p', status: 'ok', scopeIds: ['s'], service: null, ledgerVersion: 66, runs: [], workers: [], approvals: [], pools: [], diagnostics: [],
    map: { config: [], registry: { profiles: [], kinds: [] }, models: [], policy: null, memory: { available: false }, recovery: state('live', 'missing') } };
  const text = mapBlocks([install as never], 'en', { ok: '+', off: 'o', warn: '!', next: '->', sep: '|' })
    .flatMap(block => block.kind === 'line' ? [block.line.map(item => item.text).join('')] : []).join('\n');
  expect(text).toContain('! Lost-worker recovery: safety system live · recovery live · standing grant missing');
  expect(text).toContain('every lost-worker case goes to a person');
});

it('doctor: live recovery without the standing grant is a warning naming the grant list; with it, or off/shadow, ok; unread grant not tested', () => {
  const report = { platform: 'linux', host: { cpuCores: 4, totalMemMB: 8192, recommendedMaxWorkers: 3 }, company: { companyId: 'default' }, principal: { id: 'me' },
    secretStore: null, imageRefresh: null, installationBinding: null, shellRealm: null };
  const row = (recovery: 'off' | 'shadow' | 'live', grant: 'present' | 'missing' | 'partial' | 'unknown') => doctorChecks(report as never, { scopeId: 's', toolchainsRequested: false,
    identityProfile: null, backupPassphraseStored: null, retiringModels: [], poolStatus: 'ready', toolchainUpdateEnabled: false,
    recoveryMode: recoveryModeState({ nervous: 'live', recovery }, grant) }, 'en').find(check => check.id === 'work.recovery');
  expect(row('live', 'missing')).toMatchObject({ group: 'work', state: 'warning', next: 'deckent policy grants --scope s', text: expect.stringContaining('goes to a person') });
  expect(row('live', 'partial')).toMatchObject({ state: 'warning' });
  expect(row('live', 'unknown')).toMatchObject({ state: 'untested' });
  expect(row('live', 'present')).toMatchObject({ state: 'ok', text: expect.stringContaining('may continue in a new attempt') });
  expect(row('shadow', 'missing')).toMatchObject({ state: 'ok', text: expect.stringContaining('only recorded') });
  expect(row('off', 'missing')).toMatchObject({ state: 'ok' });
  expect(doctorChecks(report as never, { scopeId: 's', toolchainsRequested: false, identityProfile: null, backupPassphraseStored: null, retiringModels: [], poolStatus: 'ready',
    toolchainUpdateEnabled: false }, 'en').find(check => check.id === 'work.recovery')).toBeUndefined();
});
