import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { NOW } from '../support/catalog-metrics.js';
import { agentDefine, agentTasks, aggregator, catalogEvolutionFixture, countRows, enrol, person, plainTasks, removeRoots, seedMetrics } from '../support/catalog-evolution-fixture.js';

// S8-3 (S8-DESIGN §6, §8, §9, §10, §12): the aggregator pass writes sealed suggestions only signed by its own key — none: the pass writes nothing and the
// rows wait; it is incremental (windows cached per key), replays byte-identically, supersedes the open suggestion of a key, holds the open bound and
// narrows only from a calibrated rule in mode `on`, in the same transaction as the suggestion. A suggestion itself changes nothing (N11).
const roots: string[] = [];
afterEach(() => removeRoots(roots));
const calibratedD1 = { revision: 'site-1', rules: [{ id: 'redesign-agent', version: 2, kind: 'redesign-agent', status: 'calibrated', params: { minSamples: 10, upperBoundMicro: 500000 } }] };
async function seeded(options: Parameters<typeof catalogEvolutionFixture>[1] = {}, key = true) {
  const f = await catalogEvolutionFixture(roots, options);
  await f.catalog().defineAgent(agentDefine('auditor', 'a1'));
  if (key) await f.signers.enrol(enrol(aggregator, 'e-aggregator'));
  return f;
}
const standingOf = async (f: Awaited<ReturnType<typeof seeded>>, agentId = 'auditor') =>
  (await f.catalog().inspectAgent({ schemaVersion: 1, scopeId: 'scope', agentId })).status === 'ok' ? ((await f.catalog().inspectAgent({ schemaVersion: 1, scopeId: 'scope', agentId })) as { standings: { standing: string }[] }).standings[0]!.standing : null;

describe('signed aggregator writes', () => {
  it('no aggregator key: the pass is read-only — no position, no window, no suggestion; once a person enrols the key the same rows produce them', async () => {
    const f = await seeded({}, false);
    seedMetrics(f.path, ...agentTasks('auditor', 20, 20), ...plainTasks(10, 5));
    expect(await f.evolution().runPass('scope', 'on')).toBeNull();
    expect(['catalog_evolution_positions', 'catalog_evolution_windows', 'catalog_suggestions'].map(table => countRows(f.path, table))).toEqual([0, 0, 0]);
    await f.signers.enrol(enrol(aggregator, 'e-aggregator'));
    const pass = await f.evolution().runPass('scope', 'on');
    expect(pass).toMatchObject({ position: 30, suggestions: { written: 1, superseded: 0, narrowed: 0, skipped: 0 } });
    const listing = await f.standing(person).listSuggestions({ schemaVersion: 1, scopeId: 'scope', limit: 10 });
    expect(listing.items).toMatchObject([{ kind: 'promote-agent', mode: 'on', state: 'open', key: { kind: 'agent', agentId: 'auditor' }, producer: { issuer: aggregator.issuer },
      proposed: { kind: 'standing', to: 'active' }, window: { n: 20 } }]);
    expect(listing.labels).toEqual({ relation: 'association-not-causation', rate: 'acceptance-rate-not-accuracy' });
    // N11: the suggestion changed nothing.
    expect(await standingOf(f)).toBe('candidate');
    expect(f.host.signed.length).toBe(1);
  });
  it('N38/N41: a revoked aggregator key writes nothing more; open suggestions it signed read as superseded and are marked', async () => {
    const f = await seeded();
    seedMetrics(f.path, ...agentTasks('auditor', 20, 20), ...plainTasks(10, 5));
    await f.evolution().runPass('scope', 'on');
    const key = (await f.signers.list({ schemaVersion: 1, scopeId: 'scope' })).items[0]!;
    await f.signers.revoke({ schemaVersion: 1, scopeId: 'scope', commandId: 'r1', keyId: key.keyId });
    expect((await f.standing(person).listSuggestions({ schemaVersion: 1, scopeId: 'scope', limit: 10 })).items).toMatchObject([{ state: 'superseded', signerRevoked: true }]);
    seedMetrics(f.path, ...agentTasks('auditor', 2, 2, 'more'));
    expect(await f.evolution().runPass('scope', 'on')).toBeNull();
    expect(countRows(f.path, 'catalog_suggestions')).toBe(1);
  });
  it('negative: only the aggregator records suggestions; a person or the MCP actor is refused before anything is written', async () => {
    const f = await seeded();
    for (const principal of [person, { ...person, id: 'm', issuer: 'local-os/mcp' }])
      await expect(f.standing(principal).record('scope', { suggestions: [], narrow: [] })).rejects.toMatchObject({ code: 'AGENT_STANDING_REFUSED' });
  });
});

describe('incremental, replayable pass (N10)', () => {
  it('page by page equals one pass; a replay of the same rows writes no second suggestion; a new window supersedes the open one', async () => {
    const one = await seeded(), all = await seeded();
    for (const f of [one, all]) seedMetrics(f.path, ...agentTasks('auditor', 20, 20), ...plainTasks(10, 5));
    while (await one.evolution('on', { revision: 'site-page', pass: { passPageRows: 7 } }).runPass('scope', 'on')) { /* page by page */ }
    await all.evolution('on', { revision: 'site-page', pass: { passPageRows: 200 } }).runPass('scope', 'on');
    // The cached windows after five incremental pages equal the window of one full read, row for row.
    const windows = (f: typeof one) => { const db = new DatabaseSync(f.path, { readOnly: true }); try { return db.prepare('SELECT key_digest,record FROM catalog_evolution_windows ORDER BY key_digest').all()
      .map(row => [row['key_digest'], (JSON.parse(String(row['record'])) as { record: { tasks: unknown; events: unknown } }).record.tasks]); } finally { db.close(); } };
    expect(windows(one)).toEqual(windows(all));
    const ids = async (f: typeof one) => (await f.standing(person).listSuggestions({ schemaVersion: 1, scopeId: 'scope', open: true, limit: 10 })).items.map(row => [row.kind, row.window.inputDigest, row.window.n]);
    expect(await ids(one)).toEqual(await ids(all));
    const before = countRows(all.path, 'catalog_suggestions');
    expect(await all.evolution().runPass('scope', 'on')).toBeNull();
    expect(countRows(all.path, 'catalog_suggestions')).toBe(before);
    seedMetrics(all.path, ...agentTasks('auditor', 2, 2, 'later'));
    expect(await all.evolution().runPass('scope', 'on')).toMatchObject({ suggestions: { written: 1, superseded: 1 } });
    const states = (await all.standing(person).listSuggestions({ schemaVersion: 1, scopeId: 'scope', limit: 10 })).items.map(row => row.state);
    expect(states.sort()).toEqual(['open', 'superseded']);
    // The window cache is bounded and rebuildable; a pass reads only the new page once it holds them.
    expect(countRows(all.path, 'catalog_evolution_windows')).toBe(2);
  });
  it('the open-suggestion bound holds back the lowest-n new suggestions and counts them (an overlay may only lower it)', async () => {
    const overlay = { revision: 'site-cap', suggestions: { maxOpenSuggestions: 1 }, rules: [{ id: 'propose-agent', version: 2, kind: 'propose-agent', status: 'provisional', params: { minTasks: 3 } }] };
    const f = await seeded({ overlay });
    seedMetrics(f.path, ...plainTasks(4, 4, 'docs').map(row => ({ ...row, workClass: 'docs' })), ...plainTasks(6, 6, 'review').map(row => ({ ...row, workClass: 'review' })));
    expect(await f.evolution().runPass('scope', 'on')).toMatchObject({ suggestions: { written: 1, skipped: 1 } });
    expect((await f.standing(person).listSuggestions({ schemaVersion: 1, scopeId: 'scope', limit: 5 })).items).toMatchObject([{ kind: 'propose-agent', key: { workClass: 'review' }, window: { n: 6 } }]);
    expect(() => f.evolution('on', { revision: 'wide', suggestions: { maxOpenSuggestions: 500 } })).not.toThrow();
    await expect(f.evolution('on', { revision: 'wide', suggestions: { maxOpenSuggestions: 500 } }).runPass('scope', 'on')).rejects.toMatchObject({ code: 'CATALOG_EVOLUTION_REGISTRY_UNAVAILABLE' });
  });
});

describe('narrowing (§7, N3, N4)', () => {
  const failing = () => [...agentTasks('auditor', 10, 1), ...plainTasks(10, 5)];
  it('N3: a provisional D1 rule writes the suggestion but narrows nothing; mode shadow narrows nothing either', async () => {
    const f = await seeded();
    await f.standing(person).change({ schemaVersion: 1, scopeId: 'scope', commandId: 'p1', action: 'promote', agentId: 'auditor', revision: 1, workClass: 'feature', expectedStandingRevision: 1, suggestionId: null });
    seedMetrics(f.path, ...failing());
    expect(await f.evolution().runPass('scope', 'on')).toMatchObject({ suggestions: { written: 1, narrowed: 0 } });
    expect(await standingOf(f)).toBe('active');
    const shadow = await seeded({ overlay: calibratedD1 });
    await shadow.standing(person).change({ schemaVersion: 1, scopeId: 'scope', commandId: 'p1', action: 'promote', agentId: 'auditor', revision: 1, workClass: 'feature', expectedStandingRevision: 1, suggestionId: null });
    seedMetrics(shadow.path, ...failing());
    expect(await shadow.evolution('shadow').runPass('scope', 'shadow')).toMatchObject({ mode: 'shadow', suggestions: { written: 1, narrowed: 0 } });
    expect(await standingOf(shadow)).toBe('active');
    expect((await shadow.standing(person).listSuggestions({ schemaVersion: 1, scopeId: 'scope', limit: 5 })).items[0]).toMatchObject({ mode: 'shadow' });
  });
  it('a calibrated D1 in mode on narrows in the same transaction (signed rule basis); the audit carries refs only; existing Runs keep their seal', async () => {
    const f = await seeded({ overlay: calibratedD1 });
    await f.standing(person).change({ schemaVersion: 1, scopeId: 'scope', commandId: 'p1', action: 'promote', agentId: 'auditor', revision: 1, workClass: 'feature', expectedStandingRevision: 1, suggestionId: null });
    seedMetrics(f.path, ...failing());
    expect(await f.evolution().runPass('scope', 'on')).toMatchObject({ suggestions: { written: 1, narrowed: 1 } });
    const shown = await f.catalog().inspectAgent({ schemaVersion: 1, scopeId: 'scope', agentId: 'auditor' });
    const row = shown.status === 'ok' ? shown.standings[0]! : null;
    expect(row).toMatchObject({ standing: 'redesign-required', basis: { kind: 'rule', decidedBy: { issuer: aggregator.issuer, ai: true }, reasonCode: 'redesign-agent',
      signed: { keyId: expect.stringMatching(/^[a-f0-9]{64}$/) } } });
    const db = new DatabaseSync(f.path, { readOnly: true });
    try {
      const events = db.prepare("SELECT record FROM audit_events WHERE kind IN ('agent-standing','catalog-suggestion') ORDER BY sequence").all().map(r => String(r['record']));
      expect(events.some(e => e.includes('"narrow"'))).toBe(true);
      expect(events.join('\n')).not.toMatch(/Faturaları|persona/);
    } finally { db.close(); }
  });
  it('N4/N15: narrowing never widens: a redesign-required agent gets no promote suggestion and is restored only by a person\'s card', async () => {
    const f = await seeded({ overlay: calibratedD1 });
    await f.standing(person).change({ schemaVersion: 1, scopeId: 'scope', commandId: 'p1', action: 'promote', agentId: 'auditor', revision: 1, workClass: 'feature', expectedStandingRevision: 1, suggestionId: null });
    seedMetrics(f.path, ...failing());
    await f.evolution().runPass('scope', 'on');
    seedMetrics(f.path, ...agentTasks('auditor', 20, 20, 'good'));
    await f.evolution().runPass('scope', 'on');
    expect((await f.standing(person).listSuggestions({ schemaVersion: 1, scopeId: 'scope', limit: 10 })).items.filter(row => row.kind === 'promote-agent')).toEqual([]);
    expect(await standingOf(f)).toBe('redesign-required');
  });
});

describe('S1 propose-skill refs and the reader filter (N23)', () => {
  const lesson = (id: string) => ({ entryId: id, revision: 2, contentDigest: (id.charCodeAt(1).toString(16) + 'b'.repeat(64)).slice(0, 64), audience: { workClassFamily: 'feature', workTargetId: null } });
  it('the record holds refs and the set digest only; a reader sees refs only for lessons it may read and a count for the rest — never their ids', async () => {
    const f = await seeded({ lessons: [lesson('l1'), lesson('l2'), lesson('l3')] });
    seedMetrics(f.path, ...plainTasks(2, 2));
    await f.evolution().runPass('scope', 'on');
    f.readable.value = refs => refs.map((_, index) => index !== 1);
    const listing = await f.standing(person).listSuggestions({ schemaVersion: 1, scopeId: 'scope', limit: 10 });
    const skill = listing.items.find(row => row.kind === 'propose-skill')!;
    expect(skill.proposed).toMatchObject({ kind: 'skill-draft', template: 'skill-draft@1', withheld: 1, lessons: [{ entryId: 'l1' }, { entryId: 'l3' }] });
    expect(JSON.stringify(listing)).not.toContain('"l2"');
    const db = new DatabaseSync(f.path, { readOnly: true });
    try { expect(String(db.prepare('SELECT record FROM catalog_suggestions').all().map(r => r['record']).join())).not.toMatch(/title|correction|body/); } finally { db.close(); }
    f.readable.value = refs => refs.map(() => false);
    const hidden = await f.standing(person).inspectSuggestion({ schemaVersion: 1, scopeId: 'scope', suggestionId: skill.suggestionId });
    expect(hidden.status === 'ok' && hidden.item.proposed).toMatchObject({ lessons: [], withheld: 3 });
  });
});

describe('ledger v70', () => {
  it('suggestion rows move once from open; their content and history are append-only', async () => {
    const f = await seeded();
    seedMetrics(f.path, ...agentTasks('auditor', 20, 20), ...plainTasks(10, 5));
    await f.evolution().runPass('scope', 'on');
    const db = new DatabaseSync(f.path);
    try {
      expect(() => db.exec("UPDATE catalog_suggestions SET record='x'")).toThrow(/AGENT_CATALOG_APPEND_ONLY/);
      expect(() => db.exec('DELETE FROM catalog_suggestions')).toThrow(/AGENT_CATALOG_APPEND_ONLY/);
      expect(() => db.exec('DELETE FROM catalog_suggestion_states')).toThrow(/AGENT_CATALOG_APPEND_ONLY/);
      expect(() => db.exec('DELETE FROM catalog_evolution_windows')).toThrow(/CATALOG_EVOLUTION_POSITION_CONFLICT/);
    } finally { db.close(); }
    expect(NOW).toBeGreaterThan(0);
  });
});
