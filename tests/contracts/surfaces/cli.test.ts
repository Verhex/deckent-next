import { describe, expect, it } from 'vitest';
import { dispatch, main } from '../../../src/surfaces/index.js';

describe('surfaces/cli dispatch contract', () => {
  it('--version reports package identity with exit 0', () => {
    const r = dispatch(['--version']);
    expect(r.code).toBe(0);
    expect(r.output).toMatch(/^deckent v\d+\.\d+\.\d+/);
  });
  it('no arguments prints help with exit 0', () => {
    expect(dispatch([]).code).toBe(0);
  });
  it('unknown command exits 2 and names the command', () => {
    const r = dispatch(['frobnicate']);
    expect(r.code).toBe(2);
    expect(r.output).toContain('frobnicate');
  });
  // BeUser KER-14: under --json an unknown command is one typed error object on stderr (exit 2), never plain text.
  it('NEGATIVE: unknown command with --json writes one JSON error envelope and exits 2', async () => {
    let out = '', err = '';
    const code = await main(['frobnicate', '--json'], { env: {}, stdout: { write: (s: string) => { out += s; return true; } }, stderr: { write: (s: string) => { err += s; return true; } } });
    expect(code).toBe(2); expect(out).toBe('');
    expect(JSON.parse(err)).toMatchObject({ code: 'CLI_COMMAND_UNKNOWN', params: { command: 'frobnicate' }, message: expect.stringContaining('frobnicate') });
  });
});
