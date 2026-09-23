import { describe, expect, it } from 'vitest';
import { parseSlashLine, WORKLINE_SLASH_COMMANDS } from '#surfaces/core/terminal/index.js';

describe('terminal slash registry', () => {
  it('parses slash lines', () => {
    expect(parseSlashLine('/status')).toEqual({ command: 'status', args: '' });
    expect(parseSlashLine('  /help  ')).toEqual({ command: 'help', args: '' });
    expect(parseSlashLine('/exit now')).toEqual({ command: 'exit', args: 'now' });
    expect(parseSlashLine('hello')).toBeNull();
  });

  it('lists core commands', () => {
    expect(WORKLINE_SLASH_COMMANDS.some(cmd => cmd.name === 'help')).toBe(true);
    expect(WORKLINE_SLASH_COMMANDS.some(cmd => cmd.name === 'workers')).toBe(true);
    expect(WORKLINE_SLASH_COMMANDS.some(cmd => cmd.name === 'run')).toBe(true);
    expect(WORKLINE_SLASH_COMMANDS.some(cmd => cmd.name === 'runs')).toBe(true);
  });
});
