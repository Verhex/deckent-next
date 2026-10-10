import { describe, expect, it } from 'vitest';
import { workerRedactForRecord, workerSnapshotKnownSecrets } from '#adapters/core/native-connection/index.js';
import { EMPTY_RECORD_STREAM, feedRecordStream, finishRecordStream, previewRecordStream, RECORD_STREAM_LOOKBACK,
  redactForRecord, redactForDecision, snapshotKnownSecrets, terminalSafeText } from '#platform/index.js';

const VALUE = 'w12-Fictitious.Q7x8Y9z0', MULTILINE = 'w12-first-line\nsecond-line-012345';
const known = snapshotKnownSecrets([{ name: 'W12', value: VALUE }, { name: 'MULTILINE', value: MULTILINE }]);
function assertNoFragments(text: string, value: string) {
  for (const line of value.split('\n')) for (let at = 0; at + 5 <= line.length; at++) expect(text).not.toContain(line.slice(at, at + 5));
}
function stream(parts: string[], snapshot = known, prepare = (text: string) => text) {
  let state = EMPTY_RECORD_STREAM, committed = '';
  for (const part of parts) {
    const next = feedRecordStream(state, part, snapshot, prepare); state = next.state; committed += next.text;
    expect(state.held.length).toBeLessThanOrEqual(RECORD_STREAM_LOOKBACK);
    for (const value of [VALUE, MULTILINE]) assertNoFragments(committed + previewRecordStream(state, snapshot, prepare), value);
  }
  return committed + finishRecordStream(state, snapshot, prepare);
}
describe('bounded record stream boundary', () => {
  it.each([VALUE, MULTILINE, VALUE.slice(0, 10)+'\n'+VALUE.slice(10), VALUE.slice(0, 5)+'\r\n'+VALUE.slice(5)])('masks every two-chunk split of %s before any irreversible write or live preview', value => {
    const text = `visible before ${value} visible after\n`;
    for (let cut = 0; cut <= text.length; cut++) expect(stream([text.slice(0, cut), text.slice(cut)])).toBe(redactForRecord(text, known));
    expect(stream([...text])).toBe(redactForRecord(text, known));
  });
  it.each(['sk-w12Fictional0123456789', 'Bearer w12Fictional0123456789', 'API_KEY = w12Fictional0123456789',
    'Bearer\nw12Fictional0123456789', 'password\n=\nw12Fictional0123456789', 'https://user:w12Fictional0123456789@example.invalid/p',
    'AKIAABCDEFGHIJKLMNOP', 'eyJfictional.payload.signature'])('masks unknown credential atoms/headers across every split: %s', text => {
    const input = `before ${text} after\n`, empty = snapshotKnownSecrets([]);
    for (let cut = 0; cut <= input.length; cut++) {
      let state = EMPTY_RECORD_STREAM, committed = '';
      for (const part of [input.slice(0, cut), input.slice(cut)]) {
        const next = feedRecordStream(state, part, empty); state = next.state; committed += next.text;
        const visible = committed + previewRecordStream(state, empty);
        for (const fragment of ['Fictional', '0123456789', 'ABCDE', 'fictional', 'payload', 'signature']) expect(visible).not.toContain(fragment);
      }
      expect(committed + finishRecordStream(state, empty)).toBe(redactForRecord(input));
    }
  });
  it('covers line-wrapped known records while keeping DECISION byte-exact and snapshots opaque', () => {
    const wrapped = VALUE.slice(0, 10)+'\n'+VALUE.slice(10);
    expect(redactForRecord(wrapped, known)).toBe('‹secret:W12›');
    expect(workerRedactForRecord(wrapped, workerSnapshotKnownSecrets([{ name: 'W12', value: VALUE }]))).toBe('‹secret:W12›');
    expect(redactForDecision(wrapped, known).text).toBe(wrapped);
    expect(JSON.stringify(known)).toBe('{}');
  });
  it('preserves normal text, newline commits, Unicode, and field/call isolation', () => {
    const plain = 'Hello 🙂 世界\n```ts\nconst a = 1;\n```\n';
    expect(stream([...plain])).toBe(plain);
    const partial = feedRecordStream(EMPTY_RECORD_STREAM, VALUE.slice(0, 10), known);
    assertNoFragments(partial.text + finishRecordStream(partial.state, known), VALUE);
    expect(stream(['different field\n'])).toBe('different field\n');
  });
  it('withholds oversized unresolved text and every later chunk through end, retaining bounded state', () => {
    const long = 'W'.repeat(RECORD_STREAM_LOOKBACK * 3), snapshot = snapshotKnownSecrets([{ name: 'LONG', value: long }]);
    let state = EMPTY_RECORD_STREAM, out = '';
    for (const part of [long.slice(0, RECORD_STREAM_LOOKBACK), long.slice(RECORD_STREAM_LOOKBACK), 'suffix ordinary\n']) {
      const next = feedRecordStream(state, part, snapshot); state = next.state; out += next.text;
      expect(state.held.length).toBeLessThanOrEqual(RECORD_STREAM_LOOKBACK);
      expect(out + previewRecordStream(state, snapshot)).not.toContain('WWWWW');
    }
    expect(state).toEqual({ held: '', withheld: true }); expect(out + finishRecordStream(state, snapshot)).toBe('[REDACTED]');
    expect(feedRecordStream(EMPTY_RECORD_STREAM, VALUE.slice(0, 5)+'\r'.repeat(10_000), known).state.withheld).toBe(true);
    expect(stream(['visible ', 'sk-'+ 'q'.repeat(RECORD_STREAM_LOOKBACK * 3), ' more\n'])).toBe('visible [REDACTED]');
  });
  it('handles overlapping/repeating known suffixes and split controls without releasing raw fragments', () => {
    const repeated = snapshotKnownSecrets([{ name: 'REPEAT', value: 'abcabc' }, { name: 'OVERLAP', value: 'bcabc-tail' }]);
    const input = 'abcabc-tail ';
    expect(stream([...input], repeated)).not.toContain('abcabc');
    const withEscape = VALUE.slice(0, 10) + '\u001b]0;hidden\n\u0007' + VALUE.slice(10) + '\n';
    const crlfValue = 'CRLF-known-first\r\nsecond-012345', crlfKnown = snapshotKnownSecrets([{ name: 'CRLF', value: crlfValue }]);
    for (let cut = 0; cut <= crlfValue.length; cut++) {
      const first = feedRecordStream(EMPTY_RECORD_STREAM, crlfValue.slice(0, cut), crlfKnown, terminalSafeText);
      assertNoFragments(first.text + previewRecordStream(first.state, crlfKnown, terminalSafeText), crlfValue);
      const last = feedRecordStream(first.state, crlfValue.slice(cut), crlfKnown, terminalSafeText);
      expect(first.text + last.text + finishRecordStream(last.state, crlfKnown, terminalSafeText)).toBe('‹secret:CRLF›');
    }
    for (let cut = 0; cut <= withEscape.length; cut++) expect(stream([withEscape.slice(0, cut), withEscape.slice(cut)], known, terminalSafeText)).toBe('‹secret:W12›\n');
  });
});
